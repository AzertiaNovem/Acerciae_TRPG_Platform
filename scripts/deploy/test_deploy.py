"""Exercise release failure boundaries without touching a live server or database."""
import io
from pathlib import Path
import subprocess
import sys
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
                deploy.prepare(archive, self.root / 'unpack', self.root)
            run.assert_not_called()
        self.assertFalse((self.root / 'outside').exists())

    def test_source_release_builds_and_tests_before_service_switch(self):
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            output.add(self.new / 'backend', arcname='backend')
            member = tarfile.TarInfo('pdf-worker/package.json')
            member.size = 2
            output.addfile(member, io.BytesIO(b'{}'))
        release = self.root / 'unpack'
        with patch.object(deploy, 'run', side_effect=self.command):
            deploy.prepare(archive, release, self.root)
        self.assertEqual(self.commands[0][0], 'cmake')
        self.assertEqual(self.commands[1][:2], ['cmake', '--build'])
        self.assertEqual(self.commands[2][0], release / 'backend/build/unit_tests')
        self.assertEqual(self.commands[3][:2], ['npm', 'ci'])
        self.assertEqual(self.commands[4], ['npm', 'test'])
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual((release / 'backend/uploads').resolve(), self.root / 'uploads')

    def test_build_failure_never_activates_or_stops_live_services(self):
        args = ['deploy.py', '--archive', str(self.root / 'source.tar.gz'),
                '--commit', 'a' * 40, '--release-id', 'a' * 40 + '-42-1', '--run-number', '10']
        with patch.object(sys, 'argv', args), patch.object(deploy, 'ROOT', self.root), \
                patch.dict(deploy.os.environ), patch.object(deploy.os, 'umask'), \
                patch.object(deploy, 'preflight'), \
                patch.object(deploy, 'prepare', side_effect=subprocess.CalledProcessError(1, ['cmake'])), \
                patch.object(deploy, 'activate') as activate, patch.object(deploy, 'run') as run:
            with self.assertRaises(subprocess.CalledProcessError):
                deploy.main()
            activate.assert_not_called()
            run.assert_not_called()
        self.assertEqual((self.root / 'current').resolve(), self.old)


if __name__ == '__main__':
    unittest.main()
