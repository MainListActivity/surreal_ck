#!/usr/bin/env bash
# Isolated GitHub Actions preview: never publish as a production release.
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Apple Silicon macOS required' >&2; exit 1; }
[[ -z "${SURREAL_UPDATE_CONFIG_JSON:-}" ]] || { echo 'Preview requires no update trust configuration' >&2; exit 1; }
for name in SURREAL_CK_OIDC_ISSUER SURREAL_CK_API_BASE_URL SURREAL_CK_OIDC_CLIENT_ID SURREAL_CK_OIDC_AUDIENCE SURREAL_CK_NATIVE_REDIRECT_URI SURREAL_CK_OIDC_TOKEN_MODE SURREAL_CK_OIDC_ALLOWED_HOSTS SURREAL_CK_SURREAL_URL SURREAL_CK_SURREAL_NS; do
  [[ -z "${!name:-}" ]] || { echo 'Preview must not embed identity configuration' >&2; exit 1; }
done
bash scripts/native-client/check-native-host.sh aarch64-apple-darwin
out="$PWD/dist/macos-arm64-preview"
test ! -e "$out" || { echo 'Output must be clean' >&2; exit 1; }
python3 scripts/native-client/desktop-enterprise-preview.py --platform macos --out "$out"
app="$out/SurrealCK Enterprise Test Only.app"
binary="$app/Contents/MacOS/surreal-collaboration"
lipo "$binary" -verify_arch arm64
lipo "$binary" -archs > "$out/architecture.txt"
otool -L "$binary" > "$out/dynamic-libraries.txt"
codesign --force --sign - "$app"
codesign --verify --deep --strict --verbose=2 "$app"
mkdir "$out/dmg-content"
ditto "$app" "$out/dmg-content/SurrealCK Enterprise Test Only.app"
cp "$out/TEST-ONLY.txt" "$out/dmg-content/TEST-ONLY.txt"
ln -s /Applications "$out/dmg-content/Applications"
dmg="$out/SurrealCK-macos-apple-silicon-test-only.dmg"
hdiutil create -volname 'SurrealCK Test Only' -srcfolder "$out/dmg-content" -format UDZO "$dmg"
hdiutil verify "$dmg"
(cd "$out" && shasum -a 256 "$(basename "$dmg")") > "$out/SHA256SUMS.txt"
