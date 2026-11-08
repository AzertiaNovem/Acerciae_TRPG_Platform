"""Exercise release failure boundaries without touching a live server or database."""
import io
import json
import os
import shutil
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

    def test_prepared_object_cutover_runs_stopped_before_new_start_and_retirement_after_health(self):
        events = []
        with patch.object(deploy, 'run', side_effect=lambda a, **kw: events.append(a)), \
                patch.object(deploy, 'backup_state', side_effect=lambda *a: events.append('backup')), \
                patch.object(deploy, 'health', side_effect=lambda: events.append('health')), \
                patch.object(deploy.private_media, 'armed', return_value=True), \
                patch.object(deploy.private_media, 'cutover_for_deploy', side_effect=lambda *a: events.append('cutover')), \
                patch.object(deploy.private_media, 'retire_for_deploy', side_effect=lambda *a: events.append('retire')):
            self.activate()
        self.assertEqual(events, [deploy.STOP, 'backup', 'cutover', deploy.START, 'health', 'retire'])

    def test_object_cutover_failure_never_restarts_old_migrator(self):
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state'), \
                patch.object(deploy.private_media, 'armed', return_value=True), \
                patch.object(deploy.private_media, 'cutover_for_deploy', side_effect=RuntimeError('partial cutover')):
            with self.assertRaises(RuntimeError):
                self.activate()
        self.assertEqual(self.commands, [deploy.STOP, deploy.STOP])
        self.assertEqual((self.root / 'current').resolve(), self.new)

    def test_origin_cleanup_failure_keeps_new_healthy_service_and_release_receipt(self):
        with patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'backup_state'), \
                patch.object(deploy, 'health'), \
                patch.object(deploy.private_media, 'retire_for_deploy', side_effect=RuntimeError('R2 unavailable')):
            with self.assertRaises(RuntimeError):
                self.activate()
        self.assertEqual(self.commands, [deploy.STOP, deploy.START])
        self.assertEqual((self.root / 'current').resolve(), self.new)
        self.assertTrue((self.root / 'release.json').exists())

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
        with patch.object(deploy.shutil, 'which', return_value=None), patch.object(deploy, 'run', side_effect=self.command):
            deploy.prepare(archive, release, self.root)
        self.assertEqual(self.commands[0][0], 'cmake')
        self.assertEqual(self.commands[1][:2], ['cmake', '--build'])
        self.assertEqual(self.commands[2][0], release / 'backend/build/unit_tests')
        self.assertEqual(self.commands[3][:2], ['npm', 'ci'])
        self.assertEqual(self.commands[4], ['npm', 'test'])
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual((release / 'backend/uploads').resolve(), self.root / 'uploads')

    def test_cache_shared_across_releases_without_changing_process_environment(self):
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            output.add(self.new / 'backend', arcname='backend')
        original = os.environ.copy()
        with patch.object(deploy.shutil, 'which', return_value='/usr/bin/ccache'), patch.object(deploy, 'run') as run:
            for name in ('cached-a', 'cached-b'):
                release = self.root / name
                deploy.prepare(archive, release, self.root)
                configure, build, stats = run.call_args_list[-6:-3]
                self.assertIn('-DCMAKE_CXX_COMPILER_LAUNCHER=/usr/bin/ccache', configure.args[0])
                self.assertEqual(configure.kwargs['env'], build.kwargs['env'])
                env = build.kwargs['env']
                self.assertEqual(env['CCACHE_DIR'], str(self.root / 'cache/ccache'))
                self.assertEqual(env['CCACHE_BASEDIR'], str(release))
                self.assertEqual(env['CCACHE_COMPILERCHECK'], 'content')
                self.assertEqual(env['CCACHE_MAXSIZE'], '1G')
                self.assertEqual(stats.args[0], ['/usr/bin/ccache', '--show-stats'])
        self.assertEqual(os.environ.copy(), original)
        self.assertEqual((self.root / 'current').resolve(), self.old)

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


class ReleaseRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.releases = []
        for number in range(6):
            release = self.root / 'releases' / f'{number:040x}-42-1'
            release.mkdir(parents=True)
            os.utime(release, (100 + number, 100 + number))
            self.releases.append(release)
        (self.root / 'current').symlink_to(self.releases[0])
        (self.root / 'release.json').write_text(json.dumps({'previous_release': str(self.releases[1])}))

    def test_keeps_current_rollback_and_newest_and_is_repeatable(self):
        deploy.prune_releases(self.root)
        self.assertEqual(set((self.root / 'releases').iterdir()),
                         {self.releases[0], self.releases[1], self.releases[5]})
        deploy.prune_releases(self.root)
        self.assertEqual((self.root / 'current').resolve(), self.releases[0])

    def test_deletion_does_not_follow_upload_or_top_level_symlinks(self):
        uploads = self.root / 'uploads'
        uploads.mkdir()
        payload = uploads / 'keep.txt'
        payload.write_text('user data')
        (self.releases[2] / 'uploads').symlink_to(uploads)
        linked = self.root / 'releases/abcdef0'
        linked.symlink_to(uploads)
        backup = self.root / 'backups/before-old/database.dump'
        backup.parent.mkdir(parents=True)
        backup.write_text('backup')
        deploy.prune_releases(self.root)
        self.assertEqual(payload.read_text(), 'user data')
        self.assertTrue(linked.is_symlink())
        self.assertTrue(backup.exists())

    def test_removes_obsolete_archives_but_preserves_unknown_files(self):
        obsolete = self.root / 'releases/abcdef1.tar.gz'
        obsolete.touch()
        kept = self.root / 'releases' / (self.releases[0].name + '.tar.gz')
        kept.touch()
        unknown = self.root / 'releases/operator-notes'
        unknown.mkdir()
        deploy.prune_releases(self.root)
        self.assertFalse(obsolete.exists())
        self.assertTrue(kept.exists())
        self.assertTrue(unknown.exists())

    def test_refuses_external_current_without_deleting_anything(self):
        (self.root / 'current').unlink()
        (self.root / 'current').symlink_to(self.root)
        with self.assertRaises(RuntimeError):
            deploy.prune_releases(self.root)
        self.assertTrue(all(p.exists() for p in self.releases))

    def test_prune_mode_health_checks_under_lock_without_activation(self):
        with patch.object(sys, 'argv', ['deploy.py', '--prune']), patch.object(deploy, 'ROOT', self.root), \
                patch.dict(deploy.os.environ), patch.object(deploy.os, 'umask'), \
                patch.object(deploy, 'preflight'), patch.object(deploy, 'health') as health, \
                patch.object(deploy, 'activate') as activate, patch.object(deploy, 'prepare') as prepare:
            deploy.main()
        health.assert_called_once()
        activate.assert_not_called()
        prepare.assert_not_called()
        self.assertEqual(len(list((self.root / 'releases').iterdir())), 3)

    def test_failed_health_never_prunes(self):
        with patch.object(sys, 'argv', ['deploy.py', '--prune']), patch.object(deploy, 'ROOT', self.root), \
                patch.dict(deploy.os.environ), patch.object(deploy.os, 'umask'), \
                patch.object(deploy, 'preflight'), patch.object(deploy, 'health', side_effect=RuntimeError('unhealthy')):
            with self.assertRaises(RuntimeError):
                deploy.main()
        self.assertTrue(all(p.exists() for p in self.releases))


@unittest.skipUnless(all(shutil.which(tool) for tool in ('ccache', 'cmake', 'ninja', 'node', 'npm')), 'compiler cache integration needs ccache, CMake, Ninja and Node')
class CompilerCacheIntegrationTests(unittest.TestCase):
    def test_new_release_reuses_cache_but_header_changes_recompile(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'uploads').mkdir()
            old = root / 'old'
            old.mkdir()
            (root / 'current').symlink_to(old)
            package = {'name': 'cache-fixture', 'version': '1.0.0', 'scripts': {'test': 'node -e "process.exit(0)"'}}
            files = {
                'backend/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(cache_fixture LANGUAGES CXX)\nadd_executable(unit_tests main.cpp)\n',
                'backend/main.cpp': '#include "value.h"\n#include <iostream>\nint main() { std::cout << VALUE << " " << __FILE__; }\n',
                'pdf-worker/package.json': json.dumps(package),
                'pdf-worker/package-lock.json': json.dumps({'name': 'cache-fixture', 'version': '1.0.0', 'lockfileVersion': 3, 'packages': {'': package}}),
            }
            stats_env = {**os.environ, 'CCACHE_DIR': str(root / 'cache/ccache')}
            def stats():
                text = subprocess.check_output(['ccache', '--print-stats'], env=stats_env, text=True)
                return {key: int(value) for key, value in (line.split() for line in text.splitlines())}
            snapshots = []
            for name, value in [('release-a', 1), ('release-b', 1), ('release-c', 2)]:
                archive = root / (name + '.tar.gz')
                files['backend/value.h'] = f'#define VALUE {value}\n'
                with tarfile.open(archive, 'w:gz') as output:
                    for path, text in files.items():
                        member = tarfile.TarInfo(path)
                        data = text.encode(); member.size = len(data)
                        output.addfile(member, io.BytesIO(data))
                release = root / name
                deploy.prepare(archive, release, root)
                result = subprocess.check_output([release / 'backend/build/unit_tests'], text=True)
                self.assertTrue(result.startswith(str(value) + ' '), result)
                self.assertNotIn(str(root), result, 'source paths should be relative across releases')
                snapshots.append(stats())
            hits = lambda s: s['direct_cache_hit'] + s['preprocessed_cache_hit']
            self.assertGreater(hits(snapshots[1]), hits(snapshots[0]), 'the second release must reuse compiled output')
            self.assertGreater(snapshots[2]['cache_miss'], snapshots[1]['cache_miss'], 'a changed header must invalidate the cache')
            self.assertEqual((root / 'current').resolve(), old)


if __name__ == '__main__':
    unittest.main()
