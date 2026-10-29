#!/usr/bin/env python3
"""Select a successful CI artifact with exactly the merged tree; never rebuild at deploy time."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def api(path, paginate=False):
    args = ['gh', 'api', path]
    if paginate:
        args += ['--paginate', '--slurp']
    return json.loads(subprocess.check_output(args))


def eligible(run, repo, workflow_id):
    if (run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('workflow_id') != workflow_id or run.get('repository', {}).get('full_name') != repo
            or run.get('head_repository', {}).get('full_name') != repo):
        return False
    if run.get('event') == 'push':
        return run.get('head_branch') == 'main'
    if run.get('event') == 'pull_request' and run.get('head_branch') == 'main':
        return any(p.get('base', {}).get('ref') == 'online' and p.get('head', {}).get('sha') == run.get('head_sha')
                   for p in run.get('pull_requests', []))
    return False


def verify_manifest(manifest, run, commit, expected_tree, repo):
    if (manifest.get('schema') != 1 or manifest.get('platform') != 'ubuntu-24.04-x86_64'
            or manifest.get('repository') != repo or manifest.get('tree') != expected_tree
            or manifest.get('run_id') != run['id'] or manifest.get('run_attempt') != run['run_attempt']
            or commit['sha'] != manifest.get('build_commit') or commit['tree']['sha'] != expected_tree):
        raise RuntimeError('Artifact provenance/tree does not match the release')
    if run['event'] == 'push':
        if commit['sha'] != run['head_sha']:
            raise RuntimeError('Artifact was not built from the push commit')
    else:
        parents = [p['sha'] for p in commit['parents']]
        if not any(parents == [p['base']['sha'], p['head']['sha']] and p['base']['ref'] == 'online'
                   and p['head']['sha'] == run['head_sha'] for p in run.get('pull_requests', [])):
            raise RuntimeError('Artifact was not built from this PR merge candidate')


def fetch(destination):
    repo = os.environ['GITHUB_REPOSITORY']
    sha = os.environ['GITHUB_SHA']
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise RuntimeError('Invalid repository or release SHA')
    expected_tree = subprocess.check_output(['git', 'rev-parse', f'{sha}^{{tree}}'], text=True).strip()
    workflow_id = api(f'repos/{repo}/actions/workflows/ci.yml')['id']
    pages = api(f'repos/{repo}/actions/artifacts?name=backend-{expected_tree}&per_page=100', paginate=True)
    artifacts = sorted((a for p in pages for a in p['artifacts'] if not a['expired']), key=lambda a: a['id'], reverse=True)
    destination.mkdir(parents=True, exist_ok=True)
    for artifact in artifacts:
        run = api(f'repos/{repo}/actions/runs/{artifact["workflow_run"]["id"]}')
        if not eligible(run, repo, workflow_id):
            continue
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'artifact.zip'
            with archive.open('wb') as f:
                subprocess.run(['gh', 'api', f'repos/{repo}/actions/artifacts/{artifact["id"]}/zip'], stdout=f, check=True)
            digest = 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != artifact.get('digest'):
                raise RuntimeError('GitHub artifact digest mismatch')
            with zipfile.ZipFile(archive) as z:
                if sorted(z.namelist()) != ['build.json', 'release.tar.gz'] or z.getinfo('build.json').file_size > 16384:
                    raise RuntimeError('Unexpected artifact contents')
                manifest = json.loads(z.read('build.json'))
                build_sha = manifest.get('build_commit', '')
                if not re.fullmatch(r'[0-9a-f]{40}', build_sha):
                    raise RuntimeError('Invalid build commit')
                commit = api(f'repos/{repo}/git/commits/{build_sha}')
                verify_manifest(manifest, run, commit, expected_tree, repo)
                with z.open('release.tar.gz') as source, (destination / 'release.tar.gz').open('wb') as target:
                    import shutil
                    shutil.copyfileobj(source, target)
                if hashlib.sha256((destination / 'release.tar.gz').read_bytes()).hexdigest() != manifest.get('archive_sha256'):
                    raise RuntimeError('Release archive checksum mismatch')
                (destination / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
                f.write(f'Reusing tested artifact {artifact["id"]} from CI run {run["id"]}; tree `{expected_tree}`.\n')
            return
    raise RuntimeError('No successful, unexpired CI artifact matches the merged tree. Rerun CI on main or the online PR, then rerun this deployment; no server build was attempted.')


if __name__ == '__main__':
    fetch(Path('release-artifact'))
