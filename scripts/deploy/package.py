#!/usr/bin/env python3
"""Package the tested Linux build, its shared libraries and production PDF dependencies."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def package(destination):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('Release packaging requires Linux x86_64')
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        binary = root / 'backend/build/acerciae-server'
        binary.parent.mkdir(parents=True)
        shutil.copy2('backend/build/acerciae-server', binary)
        shutil.copytree('backend/migrations', root / 'backend/migrations')
        shutil.copytree('pdf-worker', root / 'pdf-worker', ignore=shutil.ignore_patterns('node_modules', '.env', '*.log'))
        env = {**os.environ, 'PUPPETEER_SKIP_DOWNLOAD': 'true', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1'}
        subprocess.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=root / 'pdf-worker', env=env, check=True)
        subprocess.run(['npm', 'test'], cwd=root / 'pdf-worker', env=env, check=True)
        libraries = root / 'backend/lib'
        libraries.mkdir()
        # Keep the host's loader/glibc family together; ship the remaining resolved dependency closure.
        system = re.compile(r'^(ld-linux.*|lib(c|m|dl|pthread|rt|resolv|util|anl|nss_.*)\.so(?:\..*)?)$')
        dependencies = output('ldd', str(binary))
        if 'not found' in dependencies:
            raise RuntimeError('Build has unresolved shared libraries')
        for name, path in re.findall(r'^\s*(\S+) => (/\S+) ', dependencies, re.M):
            if not system.fullmatch(name):
                shutil.copy2(path, libraries / name)
        subprocess.run(['patchelf', '--set-rpath', '$ORIGIN/../lib', str(binary)], check=True)
        for library in libraries.iterdir():
            subprocess.run(['patchelf', '--set-rpath', '$ORIGIN', str(library)], check=True)
        subprocess.run([str(binary), '--help'], check=True)
        # Also test the same relocated library set used by the packaged executable.
        subprocess.run([str(Path('backend/build/unit_tests').resolve())], env={**env, 'LD_LIBRARY_PATH': str(libraries)}, check=True)
        manifest = {
            'schema': 1, 'platform': 'ubuntu-24.04-x86_64',
            'repository': os.environ['GITHUB_REPOSITORY'],
            'build_commit': output('git', 'rev-parse', 'HEAD'),
            'tree': output('git', 'rev-parse', 'HEAD^{tree}'),
            'run_id': int(os.environ['GITHUB_RUN_ID']),
            'run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
        }
        (root / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
        archive = destination / 'release.tar.gz'
        with tarfile.open(archive, 'w:gz') as result:
            for name in ('backend', 'pdf-worker', 'build.json'):
                result.add(root / name, arcname=name)
        manifest['archive_sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        (destination / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write(f'artifact=backend-{manifest["tree"]}\n')


if __name__ == '__main__':
    package(Path('release-artifact'))
