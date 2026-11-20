#!/usr/bin/env python3
"""离线校验已审查的运行时输入并复制；不下载、不执行媒体、不代替许可审查。"""
import argparse
from datetime import datetime, timezone
import os
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import struct


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reject_root_link(path):
    # Before resolve(): otherwise a symlink/junction root silently becomes trusted input.
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        raise ValueError('Symlinks/junctions are not supported as runtime input roots')


def development_candidate(expected_hash, platform, arch):
    lock = json.loads(Path(__file__).with_name('development-media-candidate.lock.json').read_text(encoding='utf-8'))
    if os.environ.get('GITHUB_EVENT_NAME') == 'release' or os.environ.get('GITHUB_REF', '').startswith('refs/tags/'):
        raise ValueError('Development media candidates are forbidden in Release/tag builds')
    if lock.get('enabled') is not True:
        raise ValueError('Development candidate disabled pending independent review')
    if datetime.now(timezone.utc) >= datetime.fromisoformat(lock['expires_at']):
        raise ValueError('Development media candidate expired; independent revalidation required')
    if (expected_hash, platform, arch) != (lock['manifest_sha256'], lock['platform'], lock['arch']):
        raise ValueError('Development candidate is not independently pinned')
    return lock


def validate_windows_static_material(source, data):
    """Validate collected notices/link evidence, without inferring legal approval."""
    files = data['files']
    record = 'build-records/windows-static-runtime.json'
    if record not in files or record not in data.get('build_records', []):
        raise ValueError('Missing Windows static runtime evidence')
    report = json.loads((source / record).read_text(encoding='utf-8'))
    if report.get('schema') != 1:
        raise ValueError('Unsupported Windows static runtime evidence schema')
    packages = report.get('packages', {})
    required = {
        'mingw-w64-x86_64-crt': {'COPYING', 'COPYING.MinGW-w64-runtime.txt', 'COPYING.MinGW-w64.txt'},
        'mingw-w64-x86_64-headers': {'COPYING', 'COPYING.MinGW-w64-runtime.txt', 'COPYING.MinGW-w64.txt'},
        'mingw-w64-x86_64-gcc': {'COPYING3', 'COPYING.RUNTIME'},
        'mingw-w64-x86_64-winpthreads': {'COPYING'},
    }
    for name, expected in required.items():
        package = packages.get(name, {})
        notices = package.get('files', [])
        if not package.get('version') or not expected.issubset({PurePosixPath(item['path']).name for item in notices}):
            raise ValueError('Missing Windows toolchain notices: ' + name)
    for name, package in packages.items():
        if not package.get('version') or not package.get('files'):
            raise ValueError('Missing Windows package notice material: ' + name)
        for item in package['files']:
            path = item['path']
            if path not in data.get('license_files', []) or path not in files or files[path] != item.get('sha256'):
                raise ValueError('Windows notice is not bound to manifest: ' + path)
    archives = report.get('archives', {})
    if not archives:
        raise ValueError('Missing Windows static archive evidence')
    for archive in archives.values():
        if archive.get('package') and archive['package'] not in packages:
            raise ValueError('Missing archive owner notices')
    for name in ('ffmpeg', 'ffplay'):
        binary = report.get('binaries', {}).get(name, {})
        path = binary.get('map_path')
        if path not in files or path not in data.get('build_records', []) or files[path] != binary.get('map_sha256'):
            raise ValueError('Missing or mismatched final link map: ' + name)
        if binary.get('packaged_executable_sha256') != files.get('bin/' + name + '.exe'):
            raise ValueError('Final link evidence executable mismatch: ' + name)
        members = binary.get('extracted_archive_members', [])
        if not members or any(item.get('archive') not in archives for item in members):
            raise ValueError('Missing archive ownership for final link: ' + name)


def validate(source, manifest, expected_hash, platform, arch, inspection_tool=None, development=False):
    reject_root_link(source)
    reject_root_link(manifest)
    if not re.fullmatch(r'[0-9a-f]{64}', expected_hash) or sha256(manifest) != expected_hash:
        raise ValueError('Manifest must match the independently pinned SHA256')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if (data.get('schema'), data.get('platform'), data.get('arch')) != (1, platform, arch):
        raise ValueError('Manifest schema/platform/architecture mismatch')
    if development:
        development_candidate(expected_hash, platform, arch)
        if data.get('release_approved') is not False:
            raise ValueError('Development candidate must remain explicitly unapproved')
    elif data.get('release_approved') is not True:
        raise ValueError('Runtime has not been approved for redistribution')
    source = source.resolve(strict=True)
    files = data.get('files', {})
    if not isinstance(files, dict) or not files:
        raise ValueError('Missing complete file inventory')
    actual = set()
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlinks are not supported in prepared runtime inputs')
        if path.is_file():
            actual.add(path.relative_to(source).as_posix())
        elif not path.is_dir():
            raise ValueError('Special files are not permitted')
    if actual != set(files):
        raise ValueError('Runtime inventory must exactly match manifest, including notices and evidence')
    for name, digest in files.items():
        rel = PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or '\\' in name or ':' in name:
            raise ValueError('Unsafe inventory path')
        if not re.fullmatch(r'[0-9a-f]{64}', digest) or sha256(source / name) != digest:
            raise ValueError('File hash mismatch: ' + name)
    if development:
        provenance = 'build-records/provenance.json'
        lock = development_candidate(expected_hash, platform, arch)
        if provenance not in files or json.loads((source / provenance).read_text(encoding='utf-8'))['repository_commit'] != lock['source_commit']:
            raise ValueError('Development source commit mismatch')
        if platform == 'windows':
            validate_windows_static_material(source, data)
    # These are signed-off build inputs, not automatically inferred legal conclusions.
    for field in ('license_files', 'corresponding_sources', 'build_records'):
        entries = data.get(field)
        if not isinstance(entries, list) or not entries or any(p not in files for p in entries):
            raise ValueError('Missing inventoried compliance material: ' + field)
    origins = data.get('origins')
    if not isinstance(origins, list) or not origins:
        raise ValueError('Missing source provenance')
    for origin in origins:
        if not all(isinstance(origin.get(k), str) and origin[k] for k in ('url', 'version', 'sha256')):
            raise ValueError('Each origin needs URL, fixed version and SHA256')
        if not origin['url'].startswith('https://') or not re.fullmatch(r'[0-9a-f]{64}', origin['sha256']):
            raise ValueError('Invalid origin URL/hash')
    evidence_path = data.get('native_test_evidence')
    if evidence_path not in files:
        raise ValueError('Missing hashed native test evidence')
    evidence = json.loads((source / evidence_path).read_text(encoding='utf-8'))
    if (evidence.get('platform'), evidence.get('arch')) != (platform, arch):
        raise ValueError('Evidence is not for this native target')
    for check in ('clean_path', 'vp8_roundtrip', 'opus_roundtrip', 'ffplay_dummy', 'device_backends_listed'):
        if evidence.get(check) != 'passed':
            raise ValueError('Missing native test: ' + check)
    extension = '.exe' if platform == 'windows' else ''
    for tool in ('ffmpeg', 'ffplay'):
        binary = source / 'bin' / (tool + extension)
        raw = binary.read_bytes()
        if platform == 'windows':
            if raw[:2] != b'MZ' or len(raw) < 64:
                raise ValueError('Not a PE executable')
            offset = struct.unpack_from('<I', raw, 60)[0]
            machine = 0x8664 if arch == 'x86_64' else 0xAA64
            if raw[offset:offset+4] != b'PE\0\0' or struct.unpack_from('<H', raw, offset+4)[0] != machine:
                raise ValueError('PE architecture mismatch')
        else:
            machine = 0x01000007 if arch == 'x86_64' else 0x0100000C
            if raw[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', raw, 4)[0] != machine:
                raise ValueError('Expected thin native 64-bit Mach-O matching architecture')
            if binary.stat().st_mode & 0o111 == 0:
                raise ValueError('Mach-O executable mode missing')
    spec = importlib.util.spec_from_file_location('runtime_audit', Path(__file__).with_name('media-runtime.py'))
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    return audit.audit(source, platform, inspection_tool)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--platform', choices=['windows', 'macos'], required=True)
    parser.add_argument('--arch', choices=['x86_64', 'aarch64'], required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--inspection-tool')
    args = parser.parse_args()
    if args.destination.exists() or args.destination.resolve().is_relative_to(args.source.resolve()):
        raise ValueError('Destination must be absent and outside input tree')
    report = validate(args.source, args.manifest, args.manifest_sha256, args.platform, args.arch, args.inspection_tool)
    shutil.copytree(args.source, args.destination)
    # Recheck copied bytes, including a source change between validation and copy.
    validate(args.destination, args.manifest, args.manifest_sha256, args.platform, args.arch, args.inspection_tool)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
