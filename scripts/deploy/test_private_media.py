"""Exercise object loss guards and real PostgreSQL reference transactions."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid

import private_media as migration
import deploy

OLD = 'pub/channels/00000000-0000-0000-0000-000000000001/art/image.png'
NEW = migration.destination(OLD)


class ObjectSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_env_parser_does_not_execute_shell_or_expand_secrets(self):
        path = self.root / 'backend.env'
        path.write_text('DATABASE_URL="host=localhost password=literal$HOME"\nKEY=abc==\nOTHER=\'$(touch unsafe)\'\n')
        env = migration.read_env(path)
        self.assertEqual(env['DATABASE_URL'], 'host=localhost password=literal$HOME')
        self.assertEqual(env['KEY'], 'abc==')
        self.assertEqual(env['OTHER'], '$(touch unsafe)')
        self.assertFalse((self.root / 'unsafe').exists())

    def test_only_channel_objects_get_valid_stable_private_destinations(self):
        self.assertTrue(NEW.startswith('channels/00000000-0000-0000-0000-000000000001/private-upgrade-v1/'))
        for key in ('pub/../../secret.png', 'pub/users/a/avatar.png', OLD + '/../file.png', '/'+OLD):
            with self.assertRaises((ValueError, RuntimeError)):
                migration.destination(key)
        self.assertEqual(migration.destination(OLD), NEW)

    def test_database_credentials_are_decoded_without_shell_or_command_arguments(self):
        db = migration.Database({'DATABASE_URL': 'postgresql://test:p%40ss%26word@127.0.0.1:5432/example?sslmode=require'})
        self.assertEqual(db.env['PGPASSWORD'], 'p@ss&word')
        self.assertEqual(db.env['PGDATABASE'], 'example')
        self.assertEqual(db.env['PGSSLMODE'], 'require')
        result = Mock(returncode=0, stdout='1', stderr='')
        with patch.object(migration.subprocess, 'run', return_value=result) as run:
            self.assertEqual(db.execute('SELECT 1'), '1')
        self.assertNotIn('p@ss&word', ' '.join(run.call_args.args[0]))
        db = migration.Database({'DATABASE_URL': "host=localhost dbname=test user=test password='two words'"})
        self.assertEqual(db.env['PGPASSWORD'], 'two words')

    def test_inactive_server_does_not_construct_storage_clients(self):
        with patch.object(migration, 'Upgrade') as upgrade:
            migration.cutover_for_deploy(self.root, self.root / 'backup')
            migration.retire_for_deploy(self.root)
            upgrade.assert_not_called()

    def test_cutover_requires_new_release_and_stopped_services(self):
        upgrade = migration.Upgrade.__new__(migration.Upgrade)
        upgrade.root = self.root
        upgrade.state = self.root / migration.STATE
        with self.assertRaisesRegex(RuntimeError, 'lacks'):
            upgrade.cutover(None)
        directory = self.root / 'current/backend/migrations'
        directory.mkdir(parents=True)
        for name in migration.MIGRATIONS:
            (directory / name).touch()
        with patch.object(migration.subprocess, 'check_output', return_value='active\n'):
            with self.assertRaisesRegex(RuntimeError, 'stopped'):
                upgrade.cutover(None)

    def test_corrupt_local_destination_never_verifies(self):
        upgrade = migration.Upgrade.__new__(migration.Upgrade)
        upgrade.local = self.root
        (self.root / 'target.wav').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            upgrade.verify_target({'target': 'local', 'new_key': 'target.wav', 'bytes': 7,
                                   'sha256': hashlib.sha256(b'correct').hexdigest()})

    def test_local_directory_acl_grants_service_access_without_changing_storage_root(self):
        parent = self.root / 'channels/example/private-upgrade-v1'
        parent.mkdir(parents=True)
        with patch.object(migration.subprocess, 'run') as run:
            migration.allow_service_directories(parent / 'audio.wav', self.root)
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ['setfacl', '-m', 'u:acerciae:rwx,d:u:acerciae:rwx'])
        self.assertIn(str(parent), args)
        self.assertIn(str(parent.parent), args)
        self.assertNotIn(str(self.root), args)

    def test_remaining_reference_prevents_any_public_deletion(self):
        upgrade = migration.Upgrade.__new__(migration.Upgrade)
        upgrade.state = self.root
        upgrade.require_release = Mock()
        upgrade.db = Mock()
        upgrade.db.query.side_effect = [[{'name': n} for n in migration.MIGRATIONS], [{'object_key': OLD}]]
        upgrade.db.candidates.return_value = []
        upgrade.s3 = Mock()
        (self.root / 'cutover.json').write_text(json.dumps({'committed': True, 'keys': [OLD]}))
        with self.assertRaisesRegex(RuntimeError, 'references remain'):
            upgrade.retire()
        upgrade.s3.delete_object.assert_not_called()

    def test_changed_source_is_never_deleted_and_receipt_is_not_mutated(self):
        upgrade = migration.Upgrade.__new__(migration.Upgrade)
        upgrade.state = self.root
        (self.root / 'objects').mkdir()
        (self.root / 'objects' / hashlib.sha256(OLD.encode()).hexdigest()).write_bytes(b'original')
        entry = {'old_key': OLD, 'new_key': NEW, 'sha256': hashlib.sha256(b'original').hexdigest(),
                 'source_etag': 'original-etag', 'bytes': 8}
        upgrade.manifest = {'objects': {OLD: entry}}
        upgrade.public = 'public'
        upgrade.verify_target = Mock()
        upgrade.s3 = Mock()
        upgrade.head = Mock(return_value={'ETag': 'changed', 'ContentLength': 8})
        with self.assertRaisesRegex(RuntimeError, 'source changed'):
            upgrade.retire_one(OLD)
        upgrade.s3.delete_object.assert_not_called()
        self.assertNotIn('retired', entry)
        upgrade.head.return_value = None
        result = upgrade.retire_one(OLD)
        self.assertTrue(result['retired'])
        self.assertNotIn('retired', entry)
        upgrade.s3.delete_object.assert_not_called()

    def test_inventory_is_retained_until_origin_deletion_is_verified(self):
        upgrade = migration.Upgrade.__new__(migration.Upgrade)
        upgrade.manifest = {'objects': {OLD: {'retired': False}}}
        upgrade.db = Mock()
        with self.assertRaisesRegex(RuntimeError, 'verified origin deletion'):
            upgrade.clean_retired_inventory([OLD])
        upgrade.db.execute.assert_not_called()


class DeployedRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / migration.STATE
        self.state.mkdir(parents=True)
        (self.state / 'ARMED').touch()
        release = self.root / 'release'
        release.mkdir()
        (self.root / 'current').symlink_to(release)
        self.upgrade = Mock(root=self.root, state=self.state)
        self.upgrade.db.query.return_value = [{'name': n} for n in migration.MIGRATIONS]

    def test_old_schema_never_stops_services(self):
        self.upgrade.db.query.return_value = []
        with patch.object(deploy, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'already deployed'):
                migration.finish_deployed(self.upgrade)
        run.assert_not_called()
        self.upgrade.retire.assert_not_called()

    def test_failure_restarts_same_new_binary_without_retiring_origins(self):
        for failure in ('backup', 'cutover'):
            with self.subTest(failure=failure), patch.object(deploy, 'preflight'), patch.object(deploy, 'health'), \
                    patch.object(deploy, 'run') as run, patch.object(deploy, 'backup_state') as backup:
                backup.side_effect = RuntimeError('backup failed') if failure == 'backup' else None
                self.upgrade.cutover.side_effect = RuntimeError('cutover failed') if failure == 'cutover' else None
                with self.assertRaises(RuntimeError):
                    migration.finish_deployed(self.upgrade)
                self.assertEqual([c.args[0] for c in run.call_args_list], [deploy.STOP, deploy.START])
                self.upgrade.retire.assert_not_called()
                self.assertEqual((self.root / 'current').resolve(), self.root / 'release')

    def test_committed_cutover_resumes_retirement_without_another_stop(self):
        (self.state / 'cutover.json').write_text('{"committed":true}')
        with patch.object(deploy, 'preflight'), patch.object(deploy, 'health'), patch.object(deploy, 'run') as run:
            migration.finish_deployed(self.upgrade)
        run.assert_not_called()
        self.upgrade.prepare.assert_not_called()
        self.upgrade.retire.assert_called_once()


@unittest.skipUnless(os.getenv('PRIVATE_MEDIA_TEST_DATABASE_URL'), 'requires disposable PostgreSQL test database')
class ReferenceTransactionTests(unittest.TestCase):
    def setUp(self):
        self.db = migration.Database({'DATABASE_URL': os.environ['PRIVATE_MEDIA_TEST_DATABASE_URL']})
        self.schema = 'private_media_test_' + uuid.uuid4().hex
        self.db.execute('CREATE SCHEMA ' + self.schema)
        self.addCleanup(lambda: self.db.execute('DROP SCHEMA ' + self.schema + ' CASCADE'))
        self.db.env['PGOPTIONS'] = '-c search_path=' + self.schema
        self.db.execute('''
          CREATE TABLE media_assets(object_key text);
          CREATE TABLE asset_versions(object_key text);
          CREATE TABLE tts_audio_assets(object_key text);
          CREATE TABLE vn_bundle_jobs(object_key text);
          CREATE TABLE published_logs(frozen_content jsonb);
          CREATE TABLE asset_generation_jobs(params jsonb);
          CREATE TABLE unknown_claims(object_key text);
          CREATE VIEW stored_object_claims AS
            SELECT object_key FROM media_assets UNION SELECT object_key FROM asset_versions
            UNION SELECT object_key FROM tts_audio_assets UNION SELECT object_key FROM vn_bundle_jobs
            UNION SELECT object_key FROM unknown_claims
            UNION SELECT f.value->>'object_key' FROM published_logs p,
              LATERAL jsonb_each(p.frozen_content->'assets') f
            UNION SELECT f.value->>'object_key' FROM asset_generation_jobs j,
              LATERAL jsonb_array_elements(j.params->'request'->'reference_images') f;
        ''')
        for table in ('media_assets', 'asset_versions', 'tts_audio_assets', 'vn_bundle_jobs'):
            self.db.execute('INSERT INTO '+table+' VALUES ('+migration.sql_text(OLD)+')')
        self.frozen = {'assets': {'image': {'object_key': OLD, 'mime': 'image/png'}},
                       'audio': {}, 'user_text': OLD, 'empty': [], 'null': None}
        self.params = {'request': {'reference_images': [{'object_key': OLD}, {'object_key': 'unrelated'}]}, 'prompt': OLD}
        self.db.execute('INSERT INTO published_logs VALUES ('+migration.sql_text(json.dumps(self.frozen))+'::jsonb)')
        self.db.execute('INSERT INTO asset_generation_jobs VALUES ('+migration.sql_text(json.dumps(self.params))+'::jsonb)')

    def test_cutover_keeps_publication_content_and_input_order_and_is_repeatable(self):
        for _ in range(2):
            self.db.execute(migration.reference_sql([{'old_key': OLD, 'new_key': NEW}]))
        self.assertEqual(self.db.query('SELECT DISTINCT object_key FROM stored_object_claims ORDER BY object_key'),
                         [{'object_key': NEW}, {'object_key': 'unrelated'}])
        self.frozen['assets']['image']['object_key'] = NEW
        self.params['request']['reference_images'][0]['object_key'] = NEW
        self.assertEqual(self.db.query('SELECT frozen_content FROM published_logs')[0]['frozen_content'], self.frozen)
        self.assertEqual(self.db.query('SELECT params FROM asset_generation_jobs')[0]['params'], self.params)

    def test_unhandled_claim_rolls_back_all_rows_and_json(self):
        self.db.execute('INSERT INTO unknown_claims VALUES ('+migration.sql_text(OLD)+')')
        with self.assertRaises(RuntimeError):
            self.db.execute(migration.reference_sql([{'old_key': OLD, 'new_key': NEW}]))
        self.assertEqual(self.db.query('SELECT object_key FROM media_assets'), [{'object_key': OLD}])
        self.assertEqual(self.db.query('SELECT frozen_content FROM published_logs')[0]['frozen_content'], self.frozen)

    def test_empty_mapping_does_not_change_references(self):
        self.db.execute(migration.reference_sql([]))
        self.assertEqual(self.db.query('SELECT object_key FROM media_assets'), [{'object_key': OLD}])


if __name__ == '__main__':
    unittest.main()
