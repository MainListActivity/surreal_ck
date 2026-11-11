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
import tempfile
import time

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


def record_event(log, **event):
    event = dict(utc=datetime.now(timezone.utc).isoformat(), **event)
    print(json.dumps(event), flush=True)
    if log is not None:
        with log.open('a', encoding='utf-8') as output:
            output.write(json.dumps(event) + '\n')


def download_source(source, archive, name, log=None):
    curl = shutil.which('curl')
    if not curl:
        raise ValueError('System curl is required; TLS verification is never disabled')
    for attempt in range(1, 4):
        fd, temporary = tempfile.mkstemp(prefix=archive.name + '.', suffix='.partial', dir=archive.parent)
        os.close(fd)
        partial = Path(temporary)
        try:
            record_event(log, source=name, url=source['url'], stage='download', attempt=attempt)
            command = [curl, '--disable', '--fail', '--location', '--silent', '--show-error',
                       '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
                       '--connect-timeout', '20', '--max-time', '180',
                       '--write-out', '%{http_code}', '--output', str(partial), source['url']]
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=200)
                code, http, error = result.returncode, result.stdout.strip(), result.stderr
            except subprocess.TimeoutExpired:
                code, http, error = 28, '', 'curl exceeded 200-second process timeout'
            record_event(log, source=name, url=source['url'], stage='download-result', attempt=attempt,
                         returncode=code, http_status=http, error=error)
            if code == 0:
                if digest(partial) != source['sha256']:
                    record_event(log, source=name, url=source['url'], stage='hash-mismatch', attempt=attempt)
                    raise ValueError('Downloaded source SHA256 mismatch: ' + name)
                partial.replace(archive)
                record_event(log, source=name, url=source['url'], stage='download-verified', sha256=source['sha256'])
                return
            transient = code in (6, 7, 18, 28, 35, 52, 55, 56, 92) or (code == 22 and http in ('408', '429', '500', '502', '503', '504'))
            if not transient or attempt == 3:
                raise RuntimeError(f'Source download failed: {name}: curl={code}, HTTP={http}: {error}')
            time.sleep(attempt)
        finally:
            partial.unlink(missing_ok=True)


def sources(cache, destination, download, log=None):
    lock = json.loads((HERE / 'media-sources.lock.json').read_text(encoding='utf-8'))
    for name, source in lock['sources'].items():
        stage = 'cache-check'
        record_event(log, source=name, url=source['url'], stage=stage)
        try:
            archive = cache / source['filename']
            if archive.is_symlink():
                raise ValueError('Source cache symlinks are not accepted')
            if not archive.exists():
                if not download:
                    raise ValueError('Missing pinned source; use --download explicitly: ' + str(archive))
                stage = 'download'
                download_source(source, archive, name, log)
            stage = 'hash-check'
            if digest(archive) != source['sha256']:
                raise ValueError('Cached source SHA256 mismatch: ' + source['filename'])
            stage = 'extract'
            record_event(log, source=name, url=source['url'], stage=stage)
            extract(archive, destination, source['directory'])
            record_event(log, source=name, url=source['url'], stage='source-ready', sha256=source['sha256'])
        except Exception as error:
            record_event(log, source=name, url=source['url'], stage=stage, status='failed', error=str(error))
            raise
    return lock


def preserve_configure_logs(src, records, lock):
    for name, source in lock['sources'].items():
        for relative in ('config.log', 'config.h', 'config.mk', 'ffbuild/config.log', 'ffbuild/config.mak', 'vpx_config.h'):
            path = src / source['directory'] / relative
            if path.is_file():
                shutil.copy2(path, records / (name + '-' + relative.replace('/', '-')))


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
    if download:
        required += ['curl']
    missing = [tool for tool in required if not shutil.which(tool)]
    if missing:
        raise ValueError('Runner tools missing (nothing was installed): ' + ', '.join(missing))
    work.mkdir(parents=True)
    cache.mkdir(parents=True, exist_ok=True)
    src = work / 'src'
    src.mkdir()
    prefix = work / 'prefix'
    runtime = work / 'runtime'
    records = runtime / 'build-records'
    records.mkdir(parents=True)
    provenance = dict(repository_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=HERE, text=True).strip(),
        platform=target, arch=arch, host=smoke.platform.platform(), started_at=datetime.now(timezone.utc).isoformat(),
        github_run_id=os.environ.get('GITHUB_RUN_ID'), github_run_attempt=os.environ.get('GITHUB_RUN_ATTEMPT'))
    (records / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    for name in ('build-media-native.sh', 'build-media-runtime.py', 'media-sources.lock.json',
                 'smoke-media-runtime.py', 'media-runtime.py'):
        shutil.copy2(HERE / name, records / name)
    lock = sources(cache, src, download, records / 'downloads.jsonl')
    env = os.environ | dict(MEDIA_TARGET=target, MEDIA_SOURCE_ROOT=posix_path(src, target),
                            MEDIA_PREFIX=posix_path(prefix, target), MEDIA_JOBS='2')
    try:
        with (records / 'native-build.log').open('w', encoding='utf-8') as log:
            subprocess.run(['bash', posix_path(HERE / 'build-media-native.sh', target)], env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True, cwd=work, timeout=7200)
    finally:
        preserve_configure_logs(src, records, lock)
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
