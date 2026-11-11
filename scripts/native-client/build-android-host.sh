#!/usr/bin/env bash
# 实验宿主：只构建本地已安装工具链，不获取SDK、不创建签名身份、不安装设备。
set -euo pipefail
: "${ANDROID_HOME:?set existing Android SDK path}"
ndk="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/29.0.14206865}"
case "$(uname -s)" in
  Linux) host=linux-x86_64 ;;
  Darwin) host=darwin-x86_64 ;;
  *) echo 'Build host requires Linux or macOS NDK' >&2; exit 1 ;;
esac
bin="$ndk/toolchains/llvm/prebuilt/$host/bin"
[[ -x "$bin/llvm-ar" ]] || { echo 'Existing NDK29 toolchain missing' >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
python "$root/scripts/native-client/check-public-inputs.py" --platform android
features=()
if [[ "${ANDROID_NATIVE_MEDIA:-0}" == 1 ]]; then features+=(--features android-native-media); fi
if [[ "${ANDROID_NATIVE_OAUTH:-0}" == 1 ]]; then features+=(--features android-native-oauth); fi
if [[ "${ANDROID_ENTERPRISE_COLLABORATION:-0}" == 1 ]]; then
  [[ "${ANDROID_NATIVE_MEDIA:-0}" == 1 && "${ANDROID_NATIVE_OAUTH:-0}" == 1 ]] || { echo 'Enterprise preview requires explicit media and OAuth host packaging flags' >&2; exit 1; }
  features+=(--features enterprise-collaboration)
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/native-client/target}"
for target in aarch64-linux-android x86_64-linux-android; do
  normalized=${target//-/_}
  upper=$(printf '%s' "$normalized" | tr '[:lower:]' '[:upper:]')
  export "CC_$normalized=$bin/${target}28-clang"
  export "AR_$normalized=$bin/llvm-ar"
  export "CARGO_TARGET_${upper}_LINKER=$bin/${target}28-clang"
  cargo build --manifest-path "$root/native-client/android-host/Cargo.toml" --locked --offline --target "$target" --release "${features[@]}"
  "$bin/llvm-readelf" --dyn-syms --wide "$CARGO_TARGET_DIR/$target/release/libnsh.so" | grep 'Java_top_maplayer_collaboration_update_UpdaterInitProvider_initialize'
done
