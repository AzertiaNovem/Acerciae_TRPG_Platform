#!/usr/bin/env python3
"""Native, versioned deployment on server-sh. Run as deploy, never as root."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request

ROOT = Path('/srv/acerciae')
START = ['sudo', '-n', '/usr/bin/systemctl', 'start', 'acerciae.service', 'acerciae-pdf.service']
STOP = ['sudo', '-n', '/usr/bin/systemctl', 'stop', 'acerciae-pdf.service', 'acerciae.service']
DUMP = ['sudo', '-n', '-u', 'postgres', '/usr/bin/pg_dump', '--format=custom', 'acerciae']


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def atomic_json(path, data):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.replace(path)


def switch(root, release):
    temporary = root / 'current-next'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(release)
    temporary.replace(root / 'current')


def migrations(release):
    return {p.name: p.read_bytes() for p in (release / 'backend/migrations').glob('*.sql')}


def health():
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18083/api/health', timeout=2) as response:
                result = json.load(response)
            if result.get('status') == 'ok' and result.get('db') == 'ok':
                run(['/usr/bin/systemctl', 'is-active', '--quiet', 'acerciae.service', 'acerciae-pdf.service'])
                return
        except (OSError, ValueError, subprocess.CalledProcessError):
            pass
        time.sleep(1)
    raise RuntimeError('Backend/database/worker health check failed')


def preflight(root):
    if os.geteuid() == 0:
        raise RuntimeError('Run this script as deploy, not root')
    for name in ('cmake', 'ninja', 'node', 'npm', 'pg_restore', 'tar'):
        if not shutil.which(name):
            raise RuntimeError(f'Missing executable: {name}')
    for name in ('backend.env', 'pdf-worker.env'):
        with (root / name).open('rb'):
            pass  # Check access without displaying secrets.
    if not (root / 'current').is_symlink() or not (root / 'uploads').is_dir():
        raise RuntimeError('Expected existing current symlink and shared uploads directory')
    # -l checks authorization without stopping services or creating a dump.
    for args in (START, STOP, DUMP):
        run(args[:2] + ['-l'] + args[2:], stdout=subprocess.DEVNULL)
    run(['/usr/bin/systemctl', 'is-active', '--quiet', 'acerciae.service', 'acerciae-pdf.service'])


def prepare(archive, release, root):
    release.mkdir()  # Never overwrite a release, including a failed attempt.
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] not in ('backend', 'pdf-worker') or '..' in parts:
                raise RuntimeError(f'Unexpected archive path: {member.name}')
        source.extractall(release, filter='data')
    (release / 'backend/uploads').symlink_to(root / 'uploads')
    run(['cmake', '-S', release / 'backend', '-B', release / 'backend/build',
         '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'])
    run(['cmake', '--build', release / 'backend/build', '--parallel', '2'])
    run([release / 'backend/build/unit_tests'], cwd=release / 'backend')
    # Production already supplies Chromium; do not download a second browser.
    npm_env = {**os.environ, 'PUPPETEER_SKIP_DOWNLOAD': 'true', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1'}
    run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=release / 'pdf-worker', env=npm_env)
    run(['npm', 'test'], cwd=release / 'pdf-worker', env=npm_env)
    # The service runs as acerciae; archives and npm may include restrictive modes.
    for directory, dirs, files in os.walk(release, followlinks=False):
        Path(directory).chmod(Path(directory).stat().st_mode | 0o555)
        for name in files:
            path = Path(directory) / name
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | 0o444)


def backup_state(root, backup, old):
    backup.mkdir(mode=0o700)
    backup.chmod(0o700)  # Also restrict an inherited default ACL.
    with (backup / 'database.dump').open('wb') as output:
        run(DUMP, stdout=output)
    run(['pg_restore', '--list', backup / 'database.dump'], stdout=subprocess.DEVNULL)
    run(['tar', 'czf', backup / 'uploads.tar.gz', '-C', root, 'uploads'])
    for name in ('backend.env', 'pdf-worker.env', 'release.json'):
        if (root / name).exists():
            shutil.copyfile(root / name, backup / name)
    (backup / 'previous-release.txt').write_text(str(old) + '\n')
    (backup / 'COMPLETE').touch()


def activate(root, release, commit, run_number):
    old = (root / 'current').resolve(strict=True)
    old_migrations, new_migrations = migrations(old), migrations(release)
    if not old_migrations or any(new_migrations.get(k) != v for k, v in old_migrations.items()):
        raise RuntimeError('Previously deployed migrations must not be modified or removed')
    schema_changes = old_migrations != new_migrations
    backup = root / 'backups' / ('before-' + release.name)
    switch_attempted = False
    start_attempted = False
    # Stop failures can be partial too, so include the stop inside recovery handling.
    try:
        run(STOP)
        backup_state(root, backup, old)
        switch_attempted = True
        switch(root, release)
        start_attempted = True  # Startup applies migrations, including partially failing ones.
        run(START)
        health()
    except BaseException:
        if start_attempted and schema_changes:
            # Never silently run an old binary against a possibly changed database,
            # or restore a backup over user writes after the new process has started.
            run(STOP)
            print(f'Deployment failed after migration startup. Services stopped. Manual recovery required; backup: {backup}', flush=True)
        else:
            run(STOP)
            if switch_attempted:
                switch(root, old)
            run(START)
            health()
            print('Previous release restored; deployment remains failed.', flush=True)
        raise
    atomic_json(root / 'release.json', {
        'commit': commit, 'source': 'origin/online', 'run_number': run_number,
        'release': str(release), 'previous_release': str(old), 'backup': str(backup),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    })
    print(f'Deployed {commit}; backup: {backup}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only readiness check; no build, backup, or restart')
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--commit')
    parser.add_argument('--release-id')
    parser.add_argument('--run-number', type=int)
    args = parser.parse_args()
    os.environ['PATH'] = '/opt/node/bin:/usr/local/bin:/usr/bin:/bin'
    os.umask(0o022)
    preflight(ROOT)
    if args.check:
        print('Deployment prerequisites and sudo permissions verified; services unchanged.')
        return
    if not args.commit or not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('--commit must be a full Git SHA')
    if not args.release_id or not re.fullmatch(re.escape(args.commit) + r'-[0-9]+-[0-9]+', args.release_id):
        parser.error('--release-id must be <SHA>-<run ID>-<attempt>')
    if not args.archive or not args.run_number or args.run_number < 1:
        parser.error('--archive and positive --run-number are required')
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        metadata = ROOT / 'release.json'
        if metadata.exists():
            previous = json.loads(metadata.read_text())
            if previous.get('run_number', 0) > args.run_number:
                print('A newer release is already deployed; skipping this old run.')
                return
            if previous.get('commit') == args.commit:
                health()
                print('This commit is already deployed and healthy.')
                return
        release = ROOT / 'releases' / args.release_id
        prepare(args.archive, release, ROOT)
        activate(ROOT, release, args.commit, args.run_number)


def interrupted(signum, frame):
    raise InterruptedError(f'Deployment interrupted by signal {signum}')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    main()
