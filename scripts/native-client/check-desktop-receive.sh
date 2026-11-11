#!/usr/bin/env bash
# Native API probe only. Never enables production receive or changes OS privileges.
set -euo pipefail
expected=${1:?usage: check-desktop-receive.sh native-rust-triple}
case "$expected" in
  aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc) ;;
  *) echo 'Unsupported native probe target' >&2; exit 2 ;;
esac
bash scripts/native-client/check-native-host.sh "$expected"
manifest=native-transport/validation/desktop-receive-probe/Cargo.toml
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${RUNNER_TEMP:-/tmp}/desktop-receive-probe-target}"
cargo fmt --manifest-path "$manifest" --all -- --check
cargo check --manifest-path "$manifest" --locked --tests --target "$expected"
cargo test --manifest-path "$manifest" --locked --target "$expected" -- --nocapture
cargo clippy --manifest-path "$manifest" --locked --all-targets --target "$expected" -- -D warnings
printf '%s\n' 'Native default probe commands finished. Production receive remains disabled.'
if [[ "$expected" == *windows* ]]; then
  printf '%s\n' 'Ignored Windows symlink tests were NOT run. Symlink attack coverage remains an acceptance gap; no privilege/Developer Mode changes were attempted.'
fi
