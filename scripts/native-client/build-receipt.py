#!/usr/bin/env python3
"""Bind a freshly built installer to its unchanged sources, version and trust config."""
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
from update_config import parse_config

SCOPES = ['native-client', 'native-transport', 'native-updater', 'native-identity',
          'native-updater-platform', 'native-media-platform', 'native-call', 'native-video-view',
          'scripts/native-client', 'native-signaling', 'assets/icon.icns']

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024): h.update(chunk)
    return h.hexdigest()

def snapshot():
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', *SCOPES]).split(b'\0')
    h = hashlib.sha256()
    for name in sorted(set(n for n in names if n)):
        path = pathlib.Path(os.fsdecode(name))
        if path.is_file(): h.update(name + b'\0' + bytes.fromhex(digest(path)))
    config = json.loads(pathlib.Path('native-client/nsh.json').read_text())
    public_config = os.environ.get('SURREAL_UPDATE_CONFIG_JSON', '')
    validated_config = parse_config(public_config) if public_config else None
    host_arch = {'arm64':'aarch64','aarch64':'aarch64','AMD64':'x86_64','x86_64':'x86_64'}.get(platform.machine())
    if host_arch is None: raise ValueError('Unsupported actual build host architecture')
    return dict(host_arch=host_arch, version=config['version'], app_id=config['id'], build=config['build'],
        source_sha256=h.hexdigest(), commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
        dirty=bool(subprocess.check_output(['git','status','--porcelain','--',*SCOPES])),
        update_config='embedded-unverified' if public_config else 'absent-blocked',
        update_config_public=validated_config,
        update_config_sha256=hashlib.sha256(public_config.encode()).hexdigest() if public_config else None)

def main():
    action, out_arg, target = sys.argv[1:]
    out = pathlib.Path(out_arg)
    if action == 'begin':
        out.mkdir(parents=True, exist_ok=True)
        if any(out.iterdir()): raise SystemExit('Output directory is not empty; choose/move aside previous build output before rebuilding: ' + str(out))
        (out/'build-input.json').write_text(json.dumps(snapshot(), indent=2)+'\n')
    elif action == 'finish':
        before = json.loads((out/'build-input.json').read_text())
        if before != snapshot(): raise SystemExit('Sources/config changed during build; refusing a misleading receipt')
        suffix = {'android':'.apk','linux':'.tar.gz','macos':'.dmg','windows':'.exe'}[target]
        assets = [p for p in out.glob('SurrealCK-*') if p.name.endswith(suffix)]
        if len(assets) != 1: raise SystemExit('Expected one final installer')
        p = assets[0]
        receipt = before | dict(platform=target, filename=p.name, sha256=digest(p), size=p.stat().st_size,
                               validation='packaging-only; OS launch and update service not verified')
        (out/'build-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    else: raise SystemExit('Use begin or finish')

if __name__ == '__main__': main()
