#!/usr/bin/env bash
set -euo pipefail
P=/workspace/scratch/115bfa675150/native-client-probe
cd "$P/surreal_ck"
export RUSTUP_HOME="$P/rustup" CARGO_HOME="$P/cargo"
export PATH="$CARGO_HOME/bin:$PATH" CARGO_TARGET_DIR="$PWD/native-client/target" CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1
bin="$P/android-sdk/ndk/29.0.14206865/toolchains/llvm/prebuilt/linux-x86_64/bin"
for target in aarch64-linux-android x86_64-linux-android; do
 normalized=${target//-/_}; upper=$(printf '%s' "$normalized" | tr '[:lower:]' '[:upper:]')
 export "CC_$normalized=$bin/${target}28-clang" "AR_$normalized=$bin/llvm-ar" "CARGO_TARGET_${upper}_LINKER=$bin/${target}28-clang"
 cargo clippy --manifest-path native-client/android-host/Cargo.toml --locked --offline --target "$target" --release --features android-native-media,android-native-oauth -- -D warnings
done
