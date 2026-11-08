#!/usr/bin/env python3
"""One-time, resumable 0060–0062 object migration; credentials stay on the server.

prepare is safe with the old service running. CI calls cutover only with services
stopped and a complete deployment backup, then retires public copies after health.
Only an explicitly prepared and ARMED server participates in the CI hook.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MIGRATIONS = ('0060_private_script_art.sql', '0061_private_audio.sql', '0062_private_chat_art.sql')
STATE = 'upgrades/private-media-v1'


def read_env(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match:
            raise RuntimeError('Unsupported env assignment (contents withheld)')
        value = match[2].strip()
        if value.startswith(('"', "'")):
            parts = shlex.split(value, comments=True)
            if len(parts) != 1:
                raise RuntimeError('Unsupported quoted env value (contents withheld)')
            value = parts[0]
        result[match[1]] = value
    return result


def sql_text(value):
    return "E'" + str(value).replace('\\', '\\\\').replace("'", "''") + "'"


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def digest_file(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def destination(key):
    match = re.fullmatch(r'pub/channels/([0-9a-f-]+)/[^\x00]+', key)
    if not match or '..' in key or '\\' in key:
        raise RuntimeError('Unexpected legacy object key; manual inspection required')
    channel = str(uuid.UUID(match[1]))
    extension = Path(key).suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,10}', extension):
        raise RuntimeError('Unexpected legacy file extension')
    return f'channels/{channel}/private-upgrade-v1/{hashlib.sha256(key.encode()).hexdigest()}{extension}'


def allow_service_directories(path, local_root):
    # Existing uploads have ACLs, and a directory created by deploy belongs to
    # deploy:deploy. mkdir(mode=755) alone can inherit other::---, excluding the
    # service. Grant the service access on deploy-owned ancestors without opening
    # the objects tree to unrelated users; preserve defaults for later writes.
    owned = []
    for parent in path.parents:
        if parent == local_root:
            break
        if parent.stat().st_uid == os.geteuid():
            owned.append(str(parent))
    if owned:
        subprocess.run(['setfacl', '-m', 'u:acerciae:rwx,d:u:acerciae:rwx', *owned],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Database:
    def __init__(self, env):
        # psql does not expand a URI supplied through PGDATABASE. Decode into libpq
        # environment parameters instead; credentials must never appear in argv.
        dsn = env['DATABASE_URL']
        if dsn.startswith(('postgresql://', 'postgres://')):
            parsed = urllib.parse.urlsplit(dsn)
            params = dict(urllib.parse.parse_qsl(parsed.query))
            for key, value in (('host', parsed.hostname), ('port', parsed.port), ('user', parsed.username),
                               ('password', parsed.password), ('dbname', parsed.path.lstrip('/'))):
                if value is not None and value != '':
                    params.setdefault(key, urllib.parse.unquote(str(value)))
        else:
            params = dict(part.split('=', 1) for part in shlex.split(dsn))
        names = {'host': 'PGHOST', 'hostaddr': 'PGHOSTADDR', 'port': 'PGPORT', 'dbname': 'PGDATABASE',
                 'user': 'PGUSER', 'password': 'PGPASSWORD', 'sslmode': 'PGSSLMODE', 'sslcert': 'PGSSLCERT',
                 'sslkey': 'PGSSLKEY', 'sslrootcert': 'PGSSLROOTCERT', 'sslcrl': 'PGSSLCRL',
                 'connect_timeout': 'PGCONNECT_TIMEOUT', 'application_name': 'PGAPPNAME',
                 'options': 'PGOPTIONS', 'channel_binding': 'PGCHANNELBINDING',
                 'target_session_attrs': 'PGTARGETSESSIONATTRS'}
        if not params or any(k not in names for k in params):
            raise RuntimeError('Unsupported DATABASE_URL parameters; no connection attempted')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        self.env.update(PGCONNECT_TIMEOUT='10', PGAPPNAME='private-media-upgrade')
        self.env.update({names[k]: v for k, v in params.items()})

    def execute(self, sql):
        result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=sql,
                                text=True, capture_output=True, env=self.env)
        if result.returncode:
            # psql can echo SQL/data on errors. Keep credentials and private JSON out of CI logs.
            raise RuntimeError('Database operation failed; transaction rolled back if uncommitted')
        return result.stdout.strip()

    def query(self, sql):
        return json.loads(self.execute("SELECT coalesce(json_agg(q),'[]'::json) FROM (" + sql + ') q;'))

    def candidates(self):
        columns = self.query("SELECT column_name FROM information_schema.columns WHERE table_name='tts_audio_assets' AND column_name='private_source'")
        audio = 'a.private_source' if columns else """(
          NOT EXISTS (SELECT 1 FROM presentation_events e JOIN log_presentations p ON p.id=e.presentation_id
            JOIN log_snapshots s ON s.id=p.snapshot_id WHERE e.audio_asset_id=a.id AND s.scope='pl_public')
          OR EXISTS (SELECT 1 FROM presentation_events e JOIN log_presentations p ON p.id=e.presentation_id
            JOIN log_snapshots s ON s.id=p.snapshot_id WHERE e.audio_asset_id=a.id AND s.scope<>'pl_public'))"""
        return self.query("""WITH private_ids AS (
          SELECT id FROM media_assets WHERE source_reference ?| ARRAY['private_presentation_id','private_chat_window_id']
          UNION SELECT m.id FROM media_assets m JOIN asset_generation_jobs j ON j.result_asset_id=m.id
            JOIN log_presentations p ON p.id::text=j.params->'attach'->>'presentation_id'
            JOIN log_snapshots s ON s.id=p.snapshot_id WHERE s.scope<>'pl_public'
          UNION SELECT m.id FROM media_assets m JOIN asset_generation_jobs j ON j.id::text=m.source_reference->>'job_id'
            WHERE j.kind='illustration' AND jsonb_typeof(j.params->'attach'->'window_id')='string'
        ), objects AS (
          SELECT m.object_key, m.bytes, m.mime FROM media_assets m JOIN private_ids i ON i.id=m.id
          UNION SELECT v.object_key,v.bytes,v.mime FROM asset_versions v JOIN private_ids i ON i.id=v.asset_id
          UNION SELECT a.object_key,a.bytes,a.mime FROM tts_audio_assets a WHERE """ + audio + """
          UNION SELECT object_key,bytes,'application/zip' FROM vn_bundle_jobs WHERE object_key IS NOT NULL
        ) SELECT DISTINCT object_key,bytes,mime FROM objects WHERE object_key LIKE 'pub/%' ORDER BY object_key""")


class Upgrade:
    def __init__(self, root):
        self.root = Path(root)
        self.state = self.root / STATE
        self.env = read_env(self.root / 'backend.env')
        self.db = Database(self.env)
        self.endpoint = (self.env.get('R2_ENDPOINT') or
                         'https://' + self.env['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com').rstrip('/')
        self.public = self.env['R2_PUBLIC_BUCKET']
        self.private = self.env['R2_BUCKET']
        self.local = Path(self.env['UPLOAD_DIR']).resolve() / 'objects'
        self.base_url = self.env['R2_PUBLIC_BASE_URL'].rstrip('/')
        if self.public == self.private or not self.base_url.startswith('https://'):
            raise RuntimeError('Expected separate R2 buckets and an HTTPS public base URL')
        self.config = {'endpoint': self.endpoint, 'public': self.public, 'private': self.private,
                       'local': str(self.local), 'base_url': self.base_url,
                       'general': self.env.get('OBJECT_STORE', 'local'),
                       'images': self.env.get('IMAGE_STORE') or self.env.get('OBJECT_STORE', 'local')}
        if any(self.config[k] not in ('local', 'r2') for k in ('general', 'images')):
            raise RuntimeError('This one-time migration supports local/R2 storage only')
        self.manifest = {'version': 1, 'config': self.config, 'objects': {}}
        if (self.state / 'manifest.json').exists():
            self.manifest = json.loads((self.state / 'manifest.json').read_text())
            if self.manifest.get('version') != 1 or self.manifest['config'] != self.config:
                raise RuntimeError('Storage configuration changed since preparation')
        # Lazy import keeps deployment unit tests independent of an AWS SDK.
        import boto3
        from botocore.config import Config
        self.s3 = boto3.client('s3', endpoint_url=self.endpoint, region_name='auto',
                              aws_access_key_id=self.env['R2_ACCESS_KEY_ID'],
                              aws_secret_access_key=self.env['R2_SECRET_ACCESS_KEY'],
                              config=Config(connect_timeout=10, read_timeout=60,
                                            retries={'max_attempts': 3}, max_pool_connections=8))

    def save(self):
        atomic_json(self.state / 'manifest.json', self.manifest)

    def head(self, bucket, key):
        from botocore.exceptions import ClientError
        try:
            return self.s3.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                return None
            raise

    def download(self, bucket, key, output=None):
        response = self.s3.get_object(Bucket=bucket, Key=key)
        digest = hashlib.sha256()
        size = 0
        try:
            for chunk in response['Body'].iter_chunks(chunk_size=1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                if output is not None:
                    output.write(chunk)
        finally:
            response['Body'].close()
        return digest.hexdigest(), size, response

    def verify_target(self, entry, full=False):
        if entry['target'] == 'local':
            path = self.local / entry['new_key']
            if not path.is_file() or path.stat().st_size != entry['bytes'] or digest_file(path) != entry['sha256']:
                raise RuntimeError('Local destination verification failed')
        else:
            head = self.head(self.private, entry['new_key'])
            if not head or head['ContentLength'] != entry['bytes'] or head.get('ContentType') != entry['mime']:
                raise RuntimeError('R2 destination metadata verification failed')
            if full or head['ETag'] != entry.get('target_etag'):
                sha, size, _ = self.download(self.private, entry['new_key'])
                if sha != entry['sha256'] or size != entry['bytes']:
                    raise RuntimeError('R2 destination checksum verification failed')
            entry['target_etag'] = head['ETag']

    def prepare_one(self, row):
        key = row['object_key']
        new_key = destination(key)
        old = self.manifest['objects'].get(key)
        head = self.head(self.public, key)
        if not head or head['ContentLength'] != row['bytes']:
            raise RuntimeError('Public source missing or size differs from database')
        if old and old['source_etag'] != head['ETag']:
            raise RuntimeError('An immutable source changed after preparation')
        backup = self.state / 'objects' / hashlib.sha256(key.encode()).hexdigest()
        if not old or not backup.is_file():
            fd, temporary = tempfile.mkstemp(dir=backup.parent)
            try:
                with os.fdopen(fd, 'wb') as output:
                    sha, size, response = self.download(self.public, key, output)
                    output.flush()
                    os.fsync(output.fileno())
                if response['ETag'] != head['ETag'] or size != row['bytes']:
                    raise RuntimeError('Source changed while downloading')
                os.replace(temporary, backup)
            finally:
                Path(temporary).unlink(missing_ok=True)
        else:
            sha = digest_file(backup)
            if sha != old['sha256'] or backup.stat().st_size != old['bytes']:
                raise RuntimeError('Object backup checksum mismatch')
        mime = head.get('ContentType') or row['mime']
        target = self.config['images' if row['mime'].startswith('image/') else 'general']
        entry = {'old_key': key, 'new_key': new_key, 'bytes': row['bytes'], 'mime': mime,
                 'sha256': sha, 'source_etag': head['ETag'], 'target': target,
                 'channel_id': new_key.split('/')[1]}
        if target == 'r2':
            if not self.head(self.private, new_key):
                # Replace the inherited immutable public cache policy on the private copy.
                self.s3.copy_object(Bucket=self.private, Key=new_key,
                                    CopySource={'Bucket': self.public, 'Key': key},
                                    CopySourceIfMatch=head['ETag'], MetadataDirective='REPLACE',
                                    ContentType=mime, CacheControl='private, no-store')
        else:
            target_path = self.local / new_key
            target_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            allow_service_directories(target_path, self.local)
            if not target_path.exists():
                fd, temporary = tempfile.mkstemp(dir=target_path.parent)
                try:
                    with os.fdopen(fd, 'wb') as output, backup.open('rb') as source:
                        shutil.copyfileobj(source, output)
                        output.flush()
                        os.fsync(output.fileno())
                    os.chmod(temporary, 0o644)
                    os.replace(temporary, target_path)
                finally:
                    Path(temporary).unlink(missing_ok=True)
        # A saved receipt binds ETag to a previously verified SHA-256; changed targets are re-read.
        if old:
            entry['target_etag'] = old.get('target_etag')
        self.verify_target(entry, full=not old)
        return entry

    def protect(self, entries):
        if not entries:
            return
        rows = []
        for entry in entries:
            identity = ('local:' + str(self.local) if entry['target'] == 'local'
                        else 'r2:' + self.endpoint + '/' + self.private)
            rows.append('(' + ','.join(sql_text(v) for v in
                        (identity, entry['new_key'], entry['sha256'], entry['bytes'], entry['mime'], entry['channel_id'])) + ')')
        self.db.execute("""INSERT INTO stored_objects(bucket,object_key,content_hash,bytes,mime,owner_kind,owner_id,protected_until)
          SELECT bucket,key,hash,bytes::bigint,mime,'channel',channel,now()+interval '90 days'
          FROM (VALUES """ + ','.join(rows) + """) v(bucket,key,hash,bytes,mime,channel)
          ON CONFLICT(bucket,object_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,bytes=EXCLUDED.bytes,
          mime=EXCLUDED.mime,protected_until=greatest(stored_objects.protected_until,EXCLUDED.protected_until),verified_at=now();""")

    def prepare(self):
        (self.state / 'objects').mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.chmod(0o700)
        rows = self.db.candidates()
        if len({r['object_key'] for r in rows}) != len(rows):
            raise RuntimeError('Conflicting database metadata for a shared object')
        print(f'Preparing {len(rows)} objects, {sum(r["bytes"] for r in rows)} bytes', flush=True)
        with ThreadPoolExecutor(max_workers=4) as pool:
            for index, entry in enumerate(pool.map(self.prepare_one, rows), 1):
                self.manifest['objects'][entry['old_key']] = entry
                self.protect([entry])
                self.save()
                if index % 50 == 0 or index == len(rows):
                    print(f'Verified private destinations and backups: {index}/{len(rows)}', flush=True)
        self.save()
        return [self.manifest['objects'][r['object_key']] for r in rows]

    def require_release(self):
        if not all((self.root / 'current/backend/migrations' / name).is_file() for name in MIGRATIONS):
            raise RuntimeError('Current release lacks the private-media migrations; CI must switch it first')

    def cutover(self, backup):
        self.require_release()
        for service in ('acerciae.service', 'acerciae-pdf.service'):
            state = subprocess.check_output(['systemctl', 'show', '-p', 'ActiveState', '--value', service], text=True).strip()
            if state != 'inactive':
                raise RuntimeError('Reference cutover requires both platform services stopped')
        if not backup or not all((Path(backup) / f).is_file() for f in ('COMPLETE', 'database.dump', 'uploads.tar.gz', 'backend.env')):
            raise RuntimeError('A complete pre-cutover deployment backup is required')
        receipt = self.state / 'cutover.json'
        if receipt.exists():
            cutover = json.loads(receipt.read_text())
            entries = [self.manifest['objects'][k] for k in cutover['keys']]
            for entry in entries:
                self.verify_target(entry)
        else:
            # Catch objects produced by the old release since the live preparation.
            entries = self.prepare()
            cutover = {'keys': [e['old_key'] for e in entries], 'backup': str(backup), 'committed': False}
            atomic_json(receipt, cutover)
        mapping = [{'old_key': e['old_key'], 'new_key': e['new_key']} for e in entries]
        self.db.execute(reference_sql(mapping))
        cutover['committed'] = True
        atomic_json(receipt, cutover)
        print(f'Private object references switched in one transaction: {len(entries)}', flush=True)

    def retire(self):
        self.require_release()
        applied = {r['name'] for r in self.db.query('SELECT name FROM schema_migrations')}
        if not set(MIGRATIONS) <= applied:
            raise RuntimeError('Refusing public deletion before the SQL migrations have completed')
        cutover = json.loads((self.state / 'cutover.json').read_text())
        if not cutover['committed']:
            raise RuntimeError('Reference cutover is incomplete')
        keys = cutover['keys']
        refs = self.db.query('SELECT DISTINCT object_key FROM stored_object_claims WHERE object_key IN (' +
                             ','.join(sql_text(k) for k in keys) + ')') if keys else []
        if refs or self.db.candidates():
            raise RuntimeError('Public references remain; refusing deletion')
        # Independent objects share no references or keys. Keep manifest writes
        # on this thread; interrupted/failed batches safely resume via HEAD.
        with ThreadPoolExecutor(max_workers=4) as pool:
            for index, entry in enumerate(pool.map(self.retire_one, keys), 1):
                self.manifest['objects'][entry['old_key']] = entry
                self.save()
                if index % 50 == 0 or index == len(keys):
                    print(f'Retired public originals: {index}/{len(keys)}', flush=True)
        self.clean_retired_inventory(keys)
        urls = [self.base_url + '/' + urllib.parse.quote(k, safe='/') for k in keys]
        (self.state / 'cdn-purge-urls.txt').write_text(''.join(u + '\n' for u in urls))
        (self.state / 'RETIRED').touch()
        print('Public origin cleanup complete. CDN purge is still required; see cdn-purge-urls.txt.', flush=True)

    def retire_one(self, key):
        entry = dict(self.manifest['objects'][key])
        backup = self.state / 'objects' / hashlib.sha256(key.encode()).hexdigest()
        if digest_file(backup) != entry['sha256']:
            raise RuntimeError('Backup checksum mismatch; refusing deletion')
        self.verify_target(entry)
        source = self.head(self.public, key)
        if source:
            if source['ETag'] != entry['source_etag'] or source['ContentLength'] != entry['bytes']:
                raise RuntimeError('Public source changed; refusing deletion')
            self.s3.delete_object(Bucket=self.public, Key=key)
            if self.head(self.public, key):
                raise RuntimeError('Public object deletion did not complete')
        entry['retired'] = True
        return entry

    def clean_retired_inventory(self, keys):
        if not keys:
            return
        if not all(self.manifest['objects'].get(k, {}).get('retired') for k in keys):
            raise RuntimeError('Cannot remove inventory receipts before verified origin deletion')
        identity = 'r2public:' + self.endpoint + '/' + self.public
        count = self.db.execute('WITH removed AS (DELETE FROM stored_objects o WHERE bucket=' + sql_text(identity) +
                    ' AND object_key IN (' + ','.join(sql_text(k) for k in keys) + ')'
                    ' AND NOT EXISTS (SELECT 1 FROM stored_object_claims c WHERE c.object_key=o.object_key)'
                    ' RETURNING 1) SELECT count(*) FROM removed;')
        print(f'Removed retired public inventory receipts: {count}', flush=True)

    def purge(self, env_file):
        if not (self.state / 'RETIRED').exists():
            raise RuntimeError('Purge only after origin retirement, to prevent cache refills')
        env = read_env(env_file)
        zone, token = env['CLOUDFLARE_ZONE_ID'], env['CLOUDFLARE_API_TOKEN']
        if not re.fullmatch('[0-9a-f]{32}', zone):
            raise RuntimeError('Invalid Cloudflare zone ID')
        urls = (self.state / 'cdn-purge-urls.txt').read_text().splitlines()
        for start in range(0, len(urls), 10):
            request = urllib.request.Request(f'https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache',
                      data=json.dumps({'files': urls[start:start + 10]}).encode(),
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(request, timeout=30) as response:
                if not json.load(response).get('success'):
                    raise RuntimeError('Cloudflare rejected a purge batch')
            time.sleep(1)
            print(f'CDN purge accepted: {min(start + 10, len(urls))}/{len(urls)}', flush=True)
        (self.state / 'CDN_PURGE_ACCEPTED').touch()
        print('Cloudflare accepted all URL purges. Browser/downloaded copies cannot be recalled.', flush=True)


def reference_sql(mapping):
    """One transaction, including frozen publications and generation input JSON.

    The remaining-claims check rolls back everything for any unsupported owner.
    Replace only object_key values, never incidental matching text in user content.
    """
    return """BEGIN;
SET LOCAL lock_timeout='15s';
LOCK TABLE media_assets,asset_versions,tts_audio_assets,vn_bundle_jobs,published_logs,asset_generation_jobs
  IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE private_key_map ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(""" + sql_text(json.dumps(mapping)) + """::jsonb) AS t(old_key text,new_key text);
UPDATE media_assets a SET object_key=m.new_key FROM private_key_map m WHERE a.object_key=m.old_key;
UPDATE asset_versions a SET object_key=m.new_key FROM private_key_map m WHERE a.object_key=m.old_key;
UPDATE tts_audio_assets a SET object_key=m.new_key FROM private_key_map m WHERE a.object_key=m.old_key;
UPDATE vn_bundle_jobs a SET object_key=m.new_key FROM private_key_map m WHERE a.object_key=m.old_key;
CREATE FUNCTION pg_temp.rewrite_object_keys(value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  SELECT coalesce(jsonb_object_agg(e.key,CASE WHEN e.key='object_key' AND m.new_key IS NOT NULL
    THEN to_jsonb(m.new_key) ELSE pg_temp.rewrite_object_keys(e.value) END),'{}'::jsonb) INTO result
   FROM jsonb_each(value) e LEFT JOIN private_key_map m ON e.key='object_key' AND e.value=to_jsonb(m.old_key);
  RETURN result;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(pg_temp.rewrite_object_keys(e.value) ORDER BY e.n),'[]'::jsonb) INTO result
   FROM jsonb_array_elements(value) WITH ORDINALITY e(value,n);
  RETURN result;
 END IF;
 RETURN value;
END $$;
UPDATE published_logs SET frozen_content=pg_temp.rewrite_object_keys(frozen_content)
 WHERE frozen_content::text LIKE '%pub/%';
UPDATE asset_generation_jobs SET params=pg_temp.rewrite_object_keys(params) WHERE params::text LIKE '%pub/%';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM stored_object_claims c JOIN private_key_map m ON c.object_key=m.old_key) THEN
  RAISE EXCEPTION 'Unconverted object claims; refusing partial cutover';
 END IF;
END $$;
COMMIT;
"""


def armed(root):
    state = Path(root) / STATE
    return (state / 'ARMED').is_file() and not (state / 'RETIRED').exists()


def cutover_for_deploy(root, backup):
    if armed(root):
        Upgrade(root).cutover(backup)


def retire_for_deploy(root):
    if armed(root):
        Upgrade(root).retire()


def finish_deployed(upgrade):
    """Repair an already-upgraded server whose CI release omitted the opt-in hook.

    Caller holds the deployment lock. Never switches releases or applies schema.
    With the new privacy schema already active, either side of the atomic key
    transaction is readable by the same binary, so restarting it is safe on error.
    """
    import deploy
    upgrade.require_release()
    applied = {r['name'] for r in upgrade.db.query('SELECT name FROM schema_migrations')}
    if not set(MIGRATIONS) <= applied:
        raise RuntimeError('Finish requires the new application and all private-media SQL migrations already deployed')
    if (upgrade.state / 'RETIRED').exists():
        print('Origin retirement already complete; run purge for CDN cleanup.', flush=True)
        return
    if not armed(upgrade.root):
        raise RuntimeError('Prepare and arm the migration before finishing it')
    deploy.preflight(upgrade.root)
    deploy.health()
    receipt = upgrade.state / 'cutover.json'
    committed = receipt.exists() and json.loads(receipt.read_text()).get('committed')
    if not committed:
        upgrade.prepare()  # Verify/fill destinations while the application is still serving.
        backup = upgrade.root / 'backups' / ('before-private-media-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        release = (upgrade.root / 'current').resolve(strict=True)
        try:
            print('Stopping platform briefly for a consistent backup and reference cutover.', flush=True)
            deploy.run(deploy.STOP)
            deploy.backup_state(upgrade.root, backup, release)
            upgrade.cutover(backup)
        finally:
            # This is the SAME already-migrated binary, including when backup or
            # reference cutover fails. Public originals have not been deleted yet.
            deploy.run(deploy.START)
            deploy.health()
            print('Current application restored and healthy.', flush=True)
    upgrade.retire()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'prepare', 'finish', 'retire', 'purge'))
    parser.add_argument('--root', type=Path, default=Path('/srv/acerciae'))
    parser.add_argument('--cloudflare-env', type=Path)
    args = parser.parse_args()
    os.environ['PATH'] = '/opt/node/bin:/usr/local/bin:/usr/bin:/bin'
    os.umask(0o022)
    # Share the CI lock; no operator command can race an application activation.
    with (args.root / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        upgrade = Upgrade(args.root)
        if args.command == 'plan':
            rows = upgrade.db.candidates()
            print(json.dumps({'objects': len(rows), 'bytes': sum(r['bytes'] for r in rows),
                              'prepared': len(upgrade.manifest['objects'])}))
        elif args.command == 'prepare':
            if (upgrade.state / 'cutover.json').exists():
                raise RuntimeError('Cutover has started; resume via CI or retire instead')
            upgrade.prepare()
        elif args.command == 'retire':
            upgrade.retire()
        elif args.command == 'finish':
            finish_deployed(upgrade)
        else:
            upgrade.purge(args.cloudflare_env or upgrade.state / 'cloudflare.env')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK/HTTP errors may contain signed URLs; report type only for external errors.
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__, flush=True)
        raise SystemExit(1)
