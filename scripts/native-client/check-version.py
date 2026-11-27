#!/usr/bin/env python3
"""Reject mismatched runner metadata and compiled Rust package versions."""
import json
import pathlib
import sys
import tomllib

root = pathlib.Path(__file__).resolve().parents[2]
package = tomllib.loads((root / 'native-client/Cargo.toml').read_text())['package']
cargo = package['version']
nsh = json.loads((root / 'native-client/nsh.json').read_text())['version']
if cargo != nsh:
    raise SystemExit(f'Version mismatch: Cargo {cargo}, NSH {nsh}')
for path in ('native-client/Cargo.lock', 'native-client/android-host/Cargo.lock'):
    packages = tomllib.loads((root / path).read_text())['package']
    versions = [entry['version'] for entry in packages if entry['name'] == package['name']]
    if versions != [cargo]:
        raise SystemExit(f'Version mismatch: {path} records {versions}, expected {cargo}')
if len(sys.argv) > 1:
    marker = pathlib.Path(sys.argv[1]).read_text().strip()
    if marker != cargo:
        raise SystemExit(f'Archive version marker {marker} differs from Cargo {cargo}')
print(f'Native client versions agree: {cargo}')
