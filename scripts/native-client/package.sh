#!/usr/bin/env bash
set -euo pipefail
# Run from repository root. The native client is a Rust-root NSH app.
target=${1:?usage: package.sh linux|macos|android}
root=$(pwd)
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
nsh "${args[@]}"
case "$target" in
  android)
    apk=$(find "$out/raw" -maxdepth 1 -name '*.apk' -print -quit)
    test -n "$apk"
    tools="$ANDROID_HOME/build-tools/35.0.1"
    "$tools/apksigner" verify --verbose --print-certs "$apk" > "$out/apk-verification.txt"
    "$tools/zipalign" -c -P 16 4 "$apk"
    cp "$apk" "$out/SurrealCK-android-$status.apk" ;;
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
    app=$(find "$out/raw" -maxdepth 1 -name '*.app' -print -quit)
    test -n "$app"
    status=ad-hoc-not-notarized
    if [[ -n ${MACOS_SIGN_IDENTITY:-} ]]; then
      codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$app"
      status=developer-id-not-notarized
    fi
    codesign --verify --deep --strict --verbose=2 "$app"
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
