#!/usr/bin/env python3
"""Install verified NSH v0.4.0; build its macOS Intel runtime when unavailable."""
import hashlib
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

VERSION = 'v0.4.0'
# Official v0.4.0 tag, independently pinned so a moved tag fails closed.
SOURCE_COMMIT = 'e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3'
RUST_TOOLCHAIN = '1.99.1'
INTEL_TARGET = 'x86_64-apple-darwin'
MACOS_FILES = ('bin/nsh', 'runtime/macos/nsh-macos-host', 'runtime/macos/nsh-macos-app')


def build_intel_macos(dest):
    """Build the CLI and both AppKit runtimes, with upstream default features.

    v0.4.0 has no Intel archive. Its xtask dist also unconditionally builds
    iOS, GPUI, web and Android, so reproduce only its macOS distribution steps.
    """
    with tempfile.TemporaryDirectory(prefix='nsh-v0.4.0-', dir=dest) as tmp:
        source = pathlib.Path(tmp) / 'source'
        subprocess.run(['git', 'clone', '--depth', '1', '--branch', VERSION,
                        'https://github.com/longbridge/nsh.git', str(source)], check=True)
        actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != SOURCE_COMMIT:
            raise RuntimeError(f'NSH source revision mismatch: {actual}')
        target = pathlib.Path(tmp) / 'target'
        # Explicit toolchain/target avoid upstream rust-toolchain mobile targets,
        # inherited CARGO_BUILD_TARGET and release-output directory ambiguity.
        subprocess.run(['cargo', f'+{RUST_TOOLCHAIN}', 'build', '--release', '--locked',
                        '--target', INTEL_TARGET, '--target-dir', str(target),
                        '-p', 'nsh-cli', '-p', 'nsh-macos-host', '-p', 'nsh-macos-app'],
                       cwd=source, check=True)
        for relative in MACOS_FILES:
            built = target / INTEL_TARGET / 'release' / pathlib.Path(relative).name
            subprocess.run(['lipo', '-verify_arch', 'x86_64', str(built)], check=True)
            installed = dest / 'nsh' / relative
            installed.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(built, installed)
        version = subprocess.check_output([str(dest / 'nsh/bin/nsh'), '--version'], text=True).strip()
        if version != 'nsh 0.4.0':
            raise RuntimeError(f'Unexpected NSH CLI version: {version}')
        (dest / 'nsh/SOURCE_REVISION').write_text(f'{VERSION} {SOURCE_COMMIT}\n', encoding='utf-8')


def install(dest, system, arch):
    dest.mkdir(parents=True, exist_ok=True)
    if (system, arch) == ('macos', 'x86_64'):
        build_intel_macos(dest)
        return
    asset = f'nsh-{system}-{arch}.' + ('zip' if system == 'windows' else 'tar.gz')
    base = f'https://github.com/longbridge/nsh/releases/download/{VERSION}/'
    archive = dest / asset
    urllib.request.urlretrieve(base + asset, archive)
    expected = urllib.request.urlopen(base + asset + '.sha256').read().decode().split()[0]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise RuntimeError('NSH checksum mismatch')
    if system == 'windows':
        with zipfile.ZipFile(archive) as f:
            f.extractall(dest)
    else:
        with tarfile.open(archive) as f:
            f.extractall(dest, filter='data')


def main():
    system = {'Darwin': 'macos', 'Linux': 'linux', 'Windows': 'windows'}[platform.system()]
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'AMD64': 'x86_64', 'x86_64': 'x86_64'}[platform.machine()]
    dest = pathlib.Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())) / 'native-client-nsh'
    install(dest, system, arch)
    with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as f:
        f.write(str(dest / 'nsh' / 'bin') + '\n')


if __name__ == '__main__':
    main()
