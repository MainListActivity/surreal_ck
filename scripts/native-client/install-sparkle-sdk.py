#!/usr/bin/env python3
"""Fetch the pinned official Sparkle SDK for native compile checks; never creates signing keys."""
import hashlib
import os
from pathlib import Path
import platform
import plistlib
import tarfile
import tempfile
import urllib.request

VERSION = '2.10.1'
SHA256 = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27'
URL = f'https://github.com/sparkle-project/Sparkle/releases/download/{VERSION}/Sparkle-{VERSION}.tar.xz'


def extract_verified(archive, destination):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise ValueError('Sparkle SDK checksum mismatch')
    if destination.exists():
        raise ValueError('Refusing to mix an existing SDK directory')
    destination.mkdir(parents=True)
    with tarfile.open(archive) as bundle:
        bundle.extractall(destination, filter='data')
    framework = destination / 'Sparkle.framework'
    if not (framework / 'Headers/Sparkle.h').is_file():
        raise ValueError('Pinned SDK lacks Sparkle headers')
    info = plistlib.loads((framework / 'Resources/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString') != VERSION:
        raise ValueError('Sparkle framework version mismatch')
    return destination.resolve()


def main():
    if platform.system() != 'Darwin':
        raise SystemExit('Sparkle SDK setup is only for native macOS runners')
    temporary = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
    with tempfile.TemporaryDirectory(prefix='sparkle-download-', dir=temporary) as folder:
        archive = Path(folder) / 'Sparkle.tar.xz'
        urllib.request.urlretrieve(URL, archive)
        sdk = extract_verified(archive, temporary / f'surreal-ck-sparkle-{VERSION}')
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
        env.write(f'SPARKLE_FRAMEWORK_DIR={sdk}\nSPARKLE_EXPECTED_VERSION={VERSION}\n')
        # Test binaries may load the linked SDK without installing it globally.
        env.write(f'DYLD_FRAMEWORK_PATH={sdk}\n')
    print(f'Verified official Sparkle {VERSION}, SHA256 {SHA256}; no signing identity or update policy configured.')


if __name__ == '__main__':
    main()
