#!/usr/bin/env python3
"""Collect only installers, platform-specific signing status and checksums."""
import hashlib
import json
import pathlib
import shutil
import sys

target, runner = sys.argv[1:]
source = pathlib.Path('dist/native-client') / target
dest = pathlib.Path('dist/release')
dest.mkdir(parents=True, exist_ok=True)
suffix = {'linux': '.tar.gz', 'macos': '.dmg', 'windows': '.exe', 'android': '.apk'}[target]
files = sorted(p for p in source.glob('SurrealCK-*') if p.name.endswith(suffix))
if len(files) != 1:
    raise SystemExit(f'Expected exactly one {suffix} installer, got {files}')
receipt = json.loads((source / 'build-receipt.json').read_text())
asset = files[0]
if receipt['filename'] != asset.name or receipt['size'] != asset.stat().st_size or receipt['sha256'] != hashlib.sha256(asset.read_bytes()).hexdigest():
    raise SystemExit('Installer does not match its build receipt')
if receipt['platform'] != target:
    raise SystemExit('Receipt platform mismatch')
for p in files:
    shutil.copy2(p, dest / p.name)
status = dest / f'{target}-{runner}-signing-status.txt'
shutil.copy2(source / 'signing-status.txt', status)
if target == 'android':
    shutil.copy2(source / 'apk-verification.txt', dest / 'android-apk-verification.txt')
receipt_path = dest / f'{target}-{runner}-build-receipt.json'
shutil.copy2(source / 'build-receipt.json', receipt_path)
evidence_path = None
evidence = source / 'desktop-package-evidence.json'
if target in ('windows', 'macos'):
    if not evidence.is_file():
        raise SystemExit('Collaboration desktop package evidence is required')
    details = json.loads(evidence.read_text(encoding='utf-8'))
    if details.get('platform') != target or details.get('entrypoint') != 'native-client/src/main.rs':
        raise SystemExit('Desktop package evidence platform/entrypoint mismatch')
    evidence_path = dest / f'{target}-{runner}-package-evidence.json'
    shutil.copy2(evidence, evidence_path)
elif target == 'android':
    evidence = asset.with_suffix('.verification.json')
    if not evidence.is_file():
        raise SystemExit('Collaboration Android package evidence is required')
    details = json.loads(evidence.read_text(encoding='utf-8'))
    if details.get('apk_sha256') != receipt['sha256'] or details.get('requested_host_mode') != 'collaboration':
        raise SystemExit('Android package evidence does not match the collaboration APK')
    evidence_path = dest / f'{target}-{runner}-package-evidence.json'
    shutil.copy2(evidence, evidence_path)
manifest = dest / f'{target}-{runner}-SHA256SUMS.txt'
manifest.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in [*(dest / f.name for f in files), status, receipt_path, *([evidence_path] if evidence_path else [])]), encoding='utf-8')

config_path = pathlib.Path('native-client/nsh.json')
if config_path.exists():
    config = receipt
    arches = ['aarch64', 'x86_64'] if target == 'android' else [receipt['host_arch']]
    if any(arch not in ('aarch64','x86_64') for arch in arches):
        raise SystemExit('Unknown receipt architecture')
    signing = dict(line.split('=', 1) for line in status.read_text().splitlines() if '=' in line).get('signing', 'unknown')
    asset = dest / files[0].name
    records = [dict(platform=target, arch=arch, version=config['version'],
                    filename=asset.name, sha256=hashlib.sha256(asset.read_bytes()).hexdigest(),
                    size=asset.stat().st_size, signing=signing) for arch in arches]
    (dest / f'{target}-{runner}-assets.json').write_text(json.dumps(records, indent=2) + '\n')
