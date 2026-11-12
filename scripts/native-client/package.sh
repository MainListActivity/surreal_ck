#!/usr/bin/env bash
set -euo pipefail
# Run from repository root. The native client is a Rust-root NSH app.
target=${1:?usage: package.sh linux|macos|android}
root=$(pwd)
python scripts/native-client/check-public-inputs.py --platform "$target"
python scripts/native-client/check-version.py
out="$root/dist/native-client/$target"
python scripts/native-client/build-receipt.py begin "$out" "$target"
args=(package native-client --target "$target" --out "$out/raw")
status=unsigned
case "$target" in
  android)
    args+=(--abi arm64-v8a --abi x86_64)
    if [[ -n ${ANDROID_KEYSTORE_PATH:-} ]]; then
      : "${ANDROID_KEY_ALIAS:?required with keystore}" "${NSH_KEYSTORE_PASSWORD:?required with keystore}"
      args+=(--keystore "$ANDROID_KEYSTORE_PATH" --key-alias "$ANDROID_KEY_ALIAS")
      status=release-key
    else
      status=test-key
      echo '::warning::APK uses a debug/test signing key, not a production identity; upgrades across runs may require uninstall.'
    fi ;;
  linux|macos) ;;
  *) echo 'unsupported target' >&2; exit 2 ;;
esac
if [[ "$target" == macos ]]; then
  python scripts/native-client/build-desktop-app.py --platform macos --out "$out/raw"
else
  nsh "${args[@]}"
fi
case "$target" in
  android)
    apk=$(find "$out/raw" -maxdepth 1 -name '*.apk' -print -quit)
    test -n "$apk"
    tools="$ANDROID_HOME/build-tools/35.0.1"
    "$tools/apksigner" verify --verbose --print-certs "$apk" > "$out/apk-verification.txt"
    "$tools/zipalign" -c -P 16 4 "$apk"
    # NSH supplies the base resources and signing identity. Replace its default
    # host with the collaboration/updater-enabled host and verify the merged DEX/JNI/manifest.
    ANDROID_NATIVE_MEDIA=1 ANDROID_NATIVE_OAUTH=1 ANDROID_ENTERPRISE_COLLABORATION=1 \
      CARGO_TARGET_DIR="$root/native-client/target" bash scripts/native-client/build-android-host.sh
    if [[ "$status" == test-key ]]; then
      signing=(--keystore-existing "$HOME/.android/debug.keystore" --key-alias androiddebugkey --test-signing)
    else
      signing=(--keystore-existing "$ANDROID_KEYSTORE_PATH" --key-alias "$ANDROID_KEY_ALIAS")
    fi
    python scripts/native-client/package-android-host.py --enable-collaboration-host --enable-experimental-oauth \
      --input-apk "$apk" --output-apk "$out/SurrealCK-android-$status.apk" \
      --sdk "$ANDROID_HOME" \
      --native-lib "arm64-v8a=$root/native-client/target/aarch64-linux-android/release/libnsh.so" \
      --native-lib "x86_64=$root/native-client/target/x86_64-linux-android/release/libnsh.so" \
      --java-source-dir native-updater-platform/android \
      --java-source-dir native-media-platform/android/src \
      --manifest-fragment native-updater-platform/android/manifest-fragment.xml \
      --manifest-fragment native-media-platform/android/documents-manifest.xml \
      --manifest-fragment native-media-platform/android/media-manifest.xml \
      --manifest-fragment native-media-platform/android/auth-manifest.xml \
      "${signing[@]}"
    "$tools/apksigner" verify --verbose --print-certs "$out/SurrealCK-android-$status.apk" > "$out/apk-verification.txt" ;;
  linux)
    archive=$(find "$out/raw" -maxdepth 1 -name '*.tar.gz' -print -quit)
    test -n "$archive"
    # Version marker is covered by the signed update policy's archive SHA256.
    app_name=$(python -c 'import json; print(json.load(open("native-client/nsh.json"))["name"])')
    app_version=$(python -c 'import json; print(json.load(open("native-client/nsh.json"))["version"])')
    printf '%s\n' "$app_version" > "$out/raw/$app_name/release-version.txt"
    python scripts/native-client/check-version.py "$out/raw/$app_name/release-version.txt"
    tar -czf "$archive" -C "$out/raw" "$app_name"
    cp "$archive" "$out/SurrealCK-linux-$(uname -m).tar.gz" ;;
  macos)
    app="$out/raw/吉吉.app"
    test -d "$app"
    # 正式协同入口必须包含强制更新器；仅消费已有核验 SDK 和签名身份。
    bash native-updater-platform/macos/embed-framework.sh "$app"
    status=developer-id-not-notarized
    python scripts/native-client/build-desktop-app.py --platform macos --out "$out/raw" --seal
    stage="$out/dmg-stage"
    mkdir -p "$stage"
    cp -R "$app" "$stage/"
    ln -s /Applications "$stage/Applications"
    dmg="$out/SurrealCK-macos-$(uname -m).dmg"
    hdiutil create -volname SurrealCK -srcfolder "$stage" -ov -format UDZO "$dmg"
    if [[ -n ${MACOS_SIGN_IDENTITY:-} ]]; then
      codesign --timestamp --sign "$MACOS_SIGN_IDENTITY" "$dmg"
      if [[ -n ${APPLE_NOTARY_PROFILE:-} ]]; then
        xcrun notarytool submit "$dmg" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
        xcrun stapler staple "$dmg"
        xcrun stapler validate "$dmg"
        status=developer-id-notarized
      fi
    fi
    echo "macOS status: $status (ad hoc is not Apple Developer ID certification)." ;;
esac
printf 'platform=%s\nsigning=%s\ncommit=%s\n' "$target" "$status" "${GITHUB_SHA:-local}" > "$out/signing-status.txt"

python scripts/native-client/build-receipt.py finish "$out" "$target"
