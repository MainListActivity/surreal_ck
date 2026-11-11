#!/usr/bin/env python3
"""Reject mismatched runner metadata and compiled Rust package versions."""
import json
import pathlib
import sys
import tomllib

root = pathlib.Path(__file__).resolve().parents[2]
cargo = tomllib.loads((root / 'native-client/Cargo.toml').read_text())['package']['version']
nsh = json.loads((root / 'native-client/nsh.json').read_text())['version']
if cargo != nsh:
    raise SystemExit(f'Version mismatch: Cargo {cargo}, NSH {nsh}')
if len(sys.argv) > 1:
    marker = pathlib.Path(sys.argv[1]).read_text().strip()
    if marker != cargo:
        raise SystemExit(f'Archive version marker {marker} differs from Cargo {cargo}')
print(f'Native client versions agree: {cargo}')
