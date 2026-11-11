#!/usr/bin/env bash
set -euo pipefail
case "${1:?usage: check-renderer.sh macos|windows}" in
  macos) feature=macos-appkit; client_feature=experimental-macos-video ;;
  windows) feature=windows-d2d; client_feature=experimental-windows-video,windows-auto-update ;;
  *) echo 'Use a native macOS or Windows MSVC runner' >&2; exit 2 ;;
esac
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/native-client/target}"
# Full NSH platform dependency graph, not the small drawing API probe.
# Passing proves compilation/tests only, not an actual window or frame display.
cargo check --manifest-path native-video-view/Cargo.toml --locked --features "$feature"
cargo test --manifest-path native-video-view/Cargo.toml --locked --features "$feature"
cargo clippy --manifest-path native-video-view/Cargo.toml --locked --all-targets --features "$feature" -- -D warnings

# Exercise the explicit host gate without opening a window.
cargo test --manifest-path native-video-view/Cargo.toml --locked --features "$feature,experimental-host" --test registration --test support
# Check the real application's root registration AND handwritten desktop main.
# These feature flags apply only to validation commands, never default packaging.
cargo check --manifest-path native-client/Cargo.toml --locked --all-targets --features "desktop,$client_feature"
cargo test --manifest-path native-client/Cargo.toml --locked --all-targets --features "desktop,$client_feature"
cargo clippy --manifest-path native-client/Cargo.toml --locked --all-targets --features "desktop,$client_feature" -- -D warnings
