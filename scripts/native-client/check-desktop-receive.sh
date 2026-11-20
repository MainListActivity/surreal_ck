#!/usr/bin/env bash
# Native API probe only. Never enables production receive or changes OS privileges.
set -euo pipefail
expected=${1:?usage: check-desktop-receive.sh native-rust-triple}
case "$expected" in
  aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc) ;;
  *) echo 'Unsupported native probe target' >&2; exit 2 ;;
esac
# Opt-in only uses permissions already present on the native runner. Never elevate.
symlink_tests=${DESKTOP_RECEIVE_SYMLINK_TESTS:-0}
case "$symlink_tests:$expected" in
  0:*) ;;
  1:x86_64-pc-windows-msvc) ;;
  *) echo 'DESKTOP_RECEIVE_SYMLINK_TESTS must be 0, or 1 on Windows MSVC' >&2; exit 2 ;;
esac
bash scripts/native-client/check-native-host.sh "$expected"
printf 'Candidate source commit: %s\n' "$(git rev-parse HEAD)"
if [[ -n $(git status --porcelain -- native-transport/src/transfer_destination* native-transport/validation/desktop-receive-probe scripts/native-client/check-desktop-receive.sh) ]]; then
  printf '%s\n' 'WARNING: candidate sources are dirty; this is not evidence for the clean commit.'
fi
printf 'Native target: %s; Windows ignored suite requested: %s\n' "$expected" "$symlink_tests"
manifest=native-transport/validation/desktop-receive-probe/Cargo.toml
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${RUNNER_TEMP:-/tmp}/desktop-receive-probe-target}"
cargo fmt --manifest-path "$manifest" --all -- --check
cargo check --manifest-path "$manifest" --locked --tests --target "$expected"
cargo test --manifest-path "$manifest" --locked --target "$expected" -- --nocapture
if [[ "$symlink_tests" == 1 ]]; then
  # Missing symlink privilege is a failure, never a successful security negative.
  cargo test --manifest-path "$manifest" --locked --target "$expected" -- --ignored --nocapture
fi
cargo clippy --manifest-path "$manifest" --locked --all-targets --target "$expected" -- -D warnings
printf '%s\n' 'Native default probe commands finished. Production receive remains disabled.'
if [[ "$expected" == *windows* && "$symlink_tests" == 0 ]]; then
  printf '%s\n' 'Ignored Windows symlink tests were NOT run. Symlink attack coverage remains an acceptance gap; no privilege/Developer Mode changes were attempted.'
fi
printf '%s\n' 'Cross-user isolation, full transport/ACK integration, actual disk-full and crash recovery remain separate native acceptance requirements.'
