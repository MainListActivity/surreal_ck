#!/usr/bin/env python3
"""Configure the separately approved, SHA-256 pinned desktop runtime on CI."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def main():
    action, target = sys.argv[1:]
    lock = json.loads(Path(__file__).with_name('media-runtime.lock.json').read_text(encoding='utf-8'))
    entry = lock.get(target)
    if lock.get('schema') != 1 or lock.get('enabled_for_release') is not True or not isinstance(entry, dict):
        raise SystemExit(f'No approved production desktop media runtime is locked for {target}')
    run_id = entry.get('run_id')
    digest = entry.get('manifest_sha256', '')
    if type(run_id) is not int or run_id < 1 or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise SystemExit(f'Invalid production media artifact lock for {target}')
    if action == 'lock':
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            print(f'run_id={run_id}', file=output)
        return
    if action != 'configure':
        raise SystemExit('Expected lock or configure')

    root = Path(os.environ['RUNNER_TEMP']) / 'approved-media'
    source, manifest = root / 'runtime', root / 'manifest.json'
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != digest:
        raise SystemExit('Approved runtime manifest differs from pinned SHA-256')
    if json.loads(manifest.read_text(encoding='utf-8')).get('release_approved') is not True:
        raise SystemExit('Runtime manifest lacks redistribution approval')
    if target.startswith('macos-'):
        # The Actions artifact download discards POSIX executable permissions.
        for relative in ('bin/ffmpeg', 'bin/ffplay'):
            binary = source / relative
            if binary.resolve(strict=True) != root.resolve(strict=True) / 'runtime' / relative or binary.is_symlink():
                raise SystemExit('Runtime executable path contains a link')
            binary.chmod(0o755)
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
        print(f'SURREAL_MEDIA_RUNTIME_SOURCE={source}', file=env)
        print(f'SURREAL_MEDIA_RUNTIME_MANIFEST={manifest}', file=env)
        print(f'SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256={digest}', file=env)


if __name__ == '__main__':
    main()
