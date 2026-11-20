#!/usr/bin/env bash
# 仅消费事先核验来源和SHA256的本地SDK。不下载、生成密钥、公证或发布。
set -euo pipefail
app=${1:?usage: embed-framework.sh /absolute/App.app}
: "${SPARKLE_FRAMEWORK_DIR:?absolute directory containing verified Sparkle.framework}"
: "${SPARKLE_EXPECTED_VERSION:?pinned framework version}"
: "${SPARKLE_PUBLIC_ED_KEY:?existing public Ed25519 key}"
: "${SPARKLE_FEED_URL:?HTTPS appcast URL}"
: "${MACOS_SIGN_IDENTITY:?existing Developer ID signing identity}"
[[ $(uname -s) == Darwin ]] || { echo 'Requires macOS' >&2; exit 1; }
[[ "$app" = /* && "$SPARKLE_FRAMEWORK_DIR" = /* && -d "$app/Contents/MacOS" ]] || exit 1
src="$SPARKLE_FRAMEWORK_DIR/Sparkle.framework"
actual=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$src/Resources/Info.plist")
[[ "$actual" == "$SPARKLE_EXPECTED_VERSION" ]] || { echo 'Sparkle version differs from pinned version' >&2; exit 1; }
# 不覆盖已经嵌入的框架，避免并发/混合版本。
dst="$app/Contents/Frameworks/Sparkle.framework"
[[ ! -e "$dst" ]] || { echo 'Framework already exists; use a clean staging bundle' >&2; exit 1; }
mkdir -p "$app/Contents/Frameworks"
ditto "$src" "$dst"
APP_BUNDLE="$app" python3 - <<'PY'
import base64, os, plistlib, urllib.parse
key = os.environ['SPARKLE_PUBLIC_ED_KEY']
assert len(base64.b64decode(key, validate=True)) == 32
url = urllib.parse.urlsplit(os.environ['SPARKLE_FEED_URL'])
assert url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.fragment and url.port in (None,443)
p = os.path.join(os.environ['APP_BUNDLE'],'Contents','Info.plist')
with open(p,'rb') as f: data=plistlib.load(f)
data.update(SUPublicEDKey=key, SUFeedURL=url.geturl(), SUEnableAutomaticChecks=False,
            SUAutomaticallyUpdate=False, SUAllowsAutomaticUpdates=True, SUSendProfileInfo=False,
            SUVerifyUpdateBeforeExtraction=True, SUAllowedURLSchemes=["https"])
with open(p,'wb') as f: plistlib.dump(data,f)
PY
# 嵌套组件由内到外签名，禁止 --deep 代签；不改系统信任或安全设置。
for rel in 'Versions/B/XPCServices/Downloader.xpc' 'Versions/B/XPCServices/Installer.xpc' 'Versions/B/Updater.app'; do
  [[ -d "$dst/$rel" ]] || { echo "Pinned SDK component missing: $rel" >&2; exit 1; }
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$dst/$rel"
done
if [[ -f "$dst/Versions/B/Autoupdate" ]]; then
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$dst/Versions/B/Autoupdate"
fi
codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$dst"
codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
