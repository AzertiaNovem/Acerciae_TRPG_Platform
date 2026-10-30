"""Exercise release failure boundaries without touching a live server or database."""
import io
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.old = self.root / 'releases/old'
        self.new = self.root / 'releases/new'
        for release in (self.old, self.new):
            (release / 'backend/migrations').mkdir(parents=True)
            (release / 'backend/migrations/0001.sql').write_text('SELECT 1;')
        (self.root / 'current').symlink_to(self.old)
        (self.root / 'backups').mkdir()
        self.commands = []

    def command(self, args, **kwargs):
        self.commands.append(args)

    def activate(self):
        deploy.activate(self.root, self.new, 'a' * 40, 10)

    def test_success_records_exact_commit_and_preserves_old_release(self):
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state'), patch.object(deploy, 'health'):
            self.activate()
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertTrue(self.old.exists())
        metadata = deploy.json.loads((self.root / 'release.json').read_text())
        self.assertEqual(metadata['commit'], 'a' * 40)
        self.assertEqual(metadata['run_number'], 10)
        self.assertEqual(self.commands, [deploy.STOP, deploy.START])

    def test_backup_failure_restarts_old_release_without_switching(self):
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state', side_effect=OSError('disk full')), patch.object(deploy, 'health'):
            with self.assertRaises(OSError):
                self.activate()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.commands[-1], deploy.START)
        self.assertFalse((self.root / 'release.json').exists())

    def test_failed_health_without_migrations_rolls_back_binary(self):
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state'), patch.object(deploy, 'health', side_effect=[RuntimeError('unhealthy'), None]):
            with self.assertRaises(RuntimeError):
                self.activate()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.commands, [deploy.STOP, deploy.START, deploy.STOP, deploy.START])

    def test_failed_migration_stops_services_and_never_runs_old_binary(self):
        (self.new / 'backend/migrations/0002.sql').write_text('ALTER TABLE test ADD COLUMN new TEXT;')
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state'), patch.object(deploy, 'health', side_effect=RuntimeError('migration failed')):
            with self.assertRaises(RuntimeError):
                self.activate()
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertEqual(self.commands, [deploy.STOP, deploy.START, deploy.STOP])
        self.assertFalse((self.root / 'release.json').exists())

    def test_modified_migration_fails_before_stopping_services(self):
        (self.new / 'backend/migrations/0001.sql').write_text('DROP TABLE important;')
        with patch.object(deploy, 'run') as run:
            with self.assertRaises(RuntimeError):
                self.activate()
            run.assert_not_called()

    def test_partial_stop_failure_still_recovers_services(self):
        def fail_first_stop(args, **kwargs):
            self.command(args)
            if len(self.commands) == 1:
                raise subprocess.CalledProcessError(1, args)
        with patch.object(deploy, 'run', side_effect=fail_first_stop), patch.object(deploy, 'health'):
            with self.assertRaises(subprocess.CalledProcessError):
                self.activate()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(self.commands[-1], deploy.START)

    def test_archive_cannot_escape_release(self):
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            member = tarfile.TarInfo('backend/../../outside')
            member.size = 3
            output.addfile(member, io.BytesIO(b'bad'))
        with patch.object(deploy, 'run') as run:
            with self.assertRaises(RuntimeError):
                deploy.prepare(archive, self.root / 'unpack', self.root, 'b'*40, hashlib.sha256(archive.read_bytes()).hexdigest())
            run.assert_not_called()
        self.assertFalse((self.root / 'outside').exists())


    def release_archive(self, tree='b'*40):
        root = self.root / 'package'
        (root / 'backend/build').mkdir(parents=True)
        (root / 'backend/migrations').mkdir()
        (root / 'backend/build/acerciae-server').write_bytes(b'\x7fELFfixture')
        (root / 'backend/build/acerciae-server').chmod(0o755)
        (root / 'pdf-worker/node_modules').mkdir(parents=True)
        (root / 'build.json').write_text(json.dumps({'schema': 1, 'tree': tree, 'platform': 'ubuntu-24.04-x86_64'}))
        archive = self.root / 'release.tar.gz'
        with tarfile.open(archive, 'w:gz') as out:
            for path in root.iterdir():
                out.add(path, arcname=path.name)
        return archive

    def test_prebuilt_release_never_compiles_or_installs_dependencies(self):
        archive = self.release_archive()
        with patch.object(deploy.platform, 'system', return_value='Linux'), patch.object(deploy.platform, 'machine', return_value='x86_64'), patch.object(deploy, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='libraries resolved')) as run:
            deploy.prepare(archive, self.root / 'unpack', self.root, 'b'*40, hashlib.sha256(archive.read_bytes()).hexdigest())
        commands = [c.args[0] for c in run.call_args_list]
        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[0][0], 'ldd')
        self.assertEqual(commands[1][1], '--help')
        self.assertEqual(commands[2], ['npm', 'test'])

    def test_wrong_tree_or_archive_checksum_never_runs_binary(self):
        archive = self.release_archive()
        for tree, checksum in [('c'*40, hashlib.sha256(archive.read_bytes()).hexdigest()), ('b'*40, '0'*64)]:
            with patch.object(deploy, 'run') as run:
                with self.assertRaises(RuntimeError):
                    deploy.prepare(archive, self.root / tree, self.root, tree, checksum)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
