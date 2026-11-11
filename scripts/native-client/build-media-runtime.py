#!/usr/bin/env python3
"""Build a native candidate from fixed official sources. Never approves distribution or signs."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load('smoke-media-runtime')
audit = load('media-runtime')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(archive, destination, directory):
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != directory
                    or '\\' in member.name or ':' in member.name
                    or not (member.isfile() or member.isdir() or member.issym())):
                raise ValueError('Unsafe source archive member: ' + member.name)
        links = [member for member in members if member.issym()]
        for member in links:
            link = destination / member.name
            resolved = (link.parent / member.linkname).resolve()
            if not resolved.is_relative_to((destination / directory).resolve()):
                raise ValueError('Source archive link escapes tree')
        tar.extractall(destination, members=[m for m in members if not m.issym()], filter='data')
        # Materialize internal source links without Windows symlink privileges.
        # Original archives remain byte-for-byte in the corresponding-source bundle.
        for member in links:
            link = destination / member.name
            resolved = (link.parent / member.linkname).resolve(strict=True)
            if resolved.is_dir():
                shutil.copytree(resolved, link)
            else:
                shutil.copy2(resolved, link)


def sources(cache, destination, download):
    lock = json.loads((HERE / 'media-sources.lock.json').read_text(encoding='utf-8'))
    for source in lock['sources'].values():
        archive = cache / source['filename']
        if archive.is_symlink():
            raise ValueError('Source cache symlinks are not accepted')
        if not archive.exists():
            if not download:
                raise ValueError('Missing pinned source; use --download explicitly: ' + str(archive))
            partial = archive.with_suffix(archive.suffix + '.partial')
            try:
                with urllib.request.urlopen(source['url'], timeout=90) as response, partial.open('xb') as output:
                    if not response.url.startswith('https://'):
                        raise ValueError('Source download redirected outside HTTPS')
                    shutil.copyfileobj(response, output)
                if digest(partial) != source['sha256']:
                    raise ValueError('Downloaded source SHA256 mismatch')
                partial.rename(archive)
            finally:
                partial.unlink(missing_ok=True)
        if digest(archive) != source['sha256']:
            raise ValueError('Cached source SHA256 mismatch: ' + source['filename'])
        extract(archive, destination, source['directory'])
    return lock


def posix_path(path, target):
    if target == 'windows':
        return subprocess.check_output(['cygpath', '-u', str(path)], text=True).strip()
    return str(path)


def build(work, cache, target, arch, download=False):
    if smoke.native_target() != (target, arch) or (target == 'windows' and arch != 'x86_64'):
        raise ValueError('Use native macOS ARM/Intel or Windows x86_64; cross compilation is not evidence')
    if work.exists():
        raise ValueError('Build directory must not exist')
    required = ['bash', 'make', 'pkg-config', 'clang' if target == 'macos' else 'gcc',
                'otool' if target == 'macos' else 'objdump']
    if target == 'windows':
        required += ['cygpath']
    missing = [tool for tool in required if not shutil.which(tool)]
    if missing:
        raise ValueError('Runner tools missing (nothing was installed): ' + ', '.join(missing))
    work.mkdir(parents=True)
    cache.mkdir(parents=True, exist_ok=True)
    src = work / 'src'
    src.mkdir()
    lock = sources(cache, src, download)
    prefix = work / 'prefix'
    runtime = work / 'runtime'
    records = runtime / 'build-records'
    records.mkdir(parents=True)
    provenance = dict(repository_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=HERE, text=True).strip(),
        platform=target, arch=arch, host=smoke.platform.platform(), started_at=datetime.now(timezone.utc).isoformat(),
        github_run_id=os.environ.get('GITHUB_RUN_ID'), github_run_attempt=os.environ.get('GITHUB_RUN_ATTEMPT'))
    (records / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    env = os.environ | dict(MEDIA_TARGET=target, MEDIA_SOURCE_ROOT=posix_path(src, target),
                            MEDIA_PREFIX=posix_path(prefix, target), MEDIA_JOBS='2')
    with (records / 'native-build.log').open('w', encoding='utf-8') as log:
        subprocess.run(['bash', posix_path(HERE / 'build-media-native.sh', target)], env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True, cwd=work, timeout=7200)
    (runtime / 'bin').mkdir()
    extension = '.exe' if target == 'windows' else ''
    for name in ('ffmpeg', 'ffplay'):
        shutil.copy2(prefix / 'bin' / (name + extension), runtime / 'bin' / (name + extension))
    (runtime / 'sources').mkdir()
    licenses = runtime / 'licenses'
    licenses.mkdir()
    for name, source in lock['sources'].items():
        shutil.copy2(cache / source['filename'], runtime / 'sources' / source['filename'])
        for path in (src / source['directory']).iterdir():
            if path.is_file() and path.name.upper().startswith(('COPYING', 'LICENSE', 'PATENTS', 'AUTHORS')):
                shutil.copy2(path, licenses / (name + '-' + path.name))
    for name in ('build-media-native.sh', 'build-media-runtime.py', 'media-sources.lock.json',
                 'smoke-media-runtime.py', 'media-runtime.py'):
        shutil.copy2(HERE / name, records / name)
    # Preserve generated configuration and original logs needed to reproduce the exact build.
    for name, source in lock['sources'].items():
        for relative in ('config.log', 'config.h', 'config.mk', 'ffbuild/config.log', 'ffbuild/config.mak', 'vpx_config.h'):
            path = src / source['directory'] / relative
            if path.is_file():
                shutil.copy2(path, records / (name + '-' + relative.replace('/', '-')))
    static = audit.audit(runtime, target, None)
    (records / 'dependency-audit.json').write_text(json.dumps(static, indent=2), encoding='utf-8')
    evidence = smoke.smoke(runtime, target, arch, records / 'native-tests.json')
    (records / 'native-tests.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    manifest = dict(schema=1, platform=target, arch=arch, release_approved=False,
        approval_reason='Candidate only: source/license and signing review required; no human approval inferred',
        origins=[{key: value[key] for key in ('version', 'url', 'sha256')} for value in lock['sources'].values()],
        files={p.relative_to(runtime).as_posix(): digest(p) for p in runtime.rglob('*') if p.is_file()},
        license_files=[p.relative_to(runtime).as_posix() for p in licenses.iterdir()],
        corresponding_sources=[p.relative_to(runtime).as_posix() for p in (runtime / 'sources').iterdir()],
        build_records=[p.relative_to(runtime).as_posix() for p in records.iterdir()],
        native_test_evidence='build-records/native-tests.json')
    output = work / 'candidate-manifest.json'
    output.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (work / 'candidate-manifest.sha256').write_text(digest(output) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['macos', 'windows'], required=True)
    parser.add_argument('--arch', choices=['x86_64', 'aarch64'], required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    build(args.work.absolute(), args.cache.absolute(), args.platform, args.arch, args.download)
