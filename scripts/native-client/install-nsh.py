#!/usr/bin/env python3
"""Install the pinned official distribution after verifying its published checksum."""
import hashlib
import os
import pathlib
import platform
import tarfile
import urllib.request
import zipfile

VERSION = 'v0.4.0'
system = {'Darwin': 'macos', 'Linux': 'linux', 'Windows': 'windows'}[platform.system()]
arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'AMD64': 'x86_64', 'x86_64': 'x86_64'}[platform.machine()]
asset = f'nsh-{system}-{arch}.' + ('zip' if system == 'windows' else 'tar.gz')
base = f'https://github.com/longbridge/nsh/releases/download/{VERSION}/'
dest = pathlib.Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'native-client-nsh'
dest.mkdir(parents=True, exist_ok=True)
archive = dest / asset
urllib.request.urlretrieve(base + asset, archive)
expected = urllib.request.urlopen(base + asset + '.sha256').read().decode().split()[0]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected, 'NSH checksum mismatch'
if system == 'windows':
    with zipfile.ZipFile(archive) as f:
        f.extractall(dest)
else:
    with tarfile.open(archive) as f:
        f.extractall(dest, filter='data')
with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as f:
    f.write(str(dest / 'nsh' / 'bin') + '\n')
