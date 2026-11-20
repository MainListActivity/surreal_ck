#!/usr/bin/env bash
set -euo pipefail
# Share dependencies across independent workspaces instead of independent copies.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/native-client/target}"
# Default features only. Experimental platform installers are not enabled here.
for crate in native-client native-transport native-updater native-identity native-updater-platform native-media-platform native-call native-video-view native-signaling; do
  cargo fmt --manifest-path "$crate/Cargo.toml" --all -- --check
  cargo test --manifest-path "$crate/Cargo.toml" --locked
  cargo clippy --manifest-path "$crate/Cargo.toml" --locked --all-targets -- -D warnings
done

# Compile the implemented Linux renderer and decoder, without activating
# experimental macOS/Windows features or requiring a display server.
if [[ $(uname -s) == Linux ]]; then
  cargo check --manifest-path native-video-view/Cargo.toml --locked --features linux-gtk,decoder
fi
