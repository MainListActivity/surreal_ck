#!/usr/bin/env bash
# Validation only: never exports Cargo/NSH feature flags or changes package metadata.
set -euo pipefail
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/native-client/target}"
python - <<'PY'
import pathlib, tomllib
features = tomllib.loads(pathlib.Path('native-client/Cargo.toml').read_text())['features']
experimental = {'experimental-enterprise-signaling', 'experimental-enterprise-media', 'experimental-enterprise-files'}
assert experimental <= features.keys(), 'Expected explicit experimental features'
for root in ('default', 'desktop'):
    visited, pending = set(), [root]
    while pending:
        name = pending.pop()
        if name in visited: continue
        visited.add(name)
        assert name not in experimental, f'{root} must not enable enterprise preview'
        pending.extend(features.get(name, []))
print('Enterprise collaboration remains excluded from default and desktop packaging features')
PY
cargo check --manifest-path native-client/Cargo.toml --locked --all-targets --features desktop,experimental-enterprise-media,experimental-enterprise-files
cargo test --manifest-path native-client/Cargo.toml --locked --lib --test ui --features experimental-enterprise-media,experimental-enterprise-files
cargo clippy --manifest-path native-client/Cargo.toml --locked --all-targets --features desktop,experimental-enterprise-media,experimental-enterprise-files -- -D warnings
