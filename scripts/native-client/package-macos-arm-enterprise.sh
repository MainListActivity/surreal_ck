#!/usr/bin/env bash
# macOS arm64 企业桌面测试包：自动加载仓库受版本控制的公开身份配置
# （native-client/config/enterprise-public.env），无需人工填写 client_id。
# 与 package-macos-arm-preview.sh 隔离：预览包仍禁止任何 SURREAL_CK_* 输入。
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Apple Silicon macOS required' >&2; exit 1; }
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

# 更新信任门禁与预览一致：未配置更新策略的构建保持锁定，不得伪造。
[[ -z "${SURREAL_UPDATE_CONFIG_JSON:-}" ]] || { echo 'Enterprise test build requires no update trust configuration' >&2; exit 1; }

set -a
source native-client/config/enterprise-public.env
set +a

bash scripts/native-client/check-native-host.sh aarch64-apple-darwin
# 身份必须 configured-unverified；更新策略 absent-blocked = 保持更新锁定。
python3 scripts/native-client/check-public-inputs.py --platform macos

out="$PWD/dist/macos-arm64-enterprise"
test ! -e "$out" || { echo 'Output must be clean' >&2; exit 1; }
python3 scripts/native-client/desktop-enterprise-preview.py --platform macos --out "$out"
app="$out/吉吉.app"
binary="$app/Contents/MacOS/surreal-collaboration"
lipo "$binary" -verify_arch arm64
lipo "$binary" -archs > "$out/architecture.txt"
otool -L "$binary" > "$out/dynamic-libraries.txt"
codesign --force --sign - "$app"
codesign --verify --deep --strict --verbose=2 "$app"
python3 native-client/scripts/brand_icon.py verify-bundle "$app" > "$out/app-icon.json"
mkdir "$out/dmg-content"
ditto "$app" "$out/dmg-content/吉吉.app"
ln -s /Applications "$out/dmg-content/Applications"
dmg="$out/Jiji-enterprise-macos-arm64.dmg"
hdiutil create -volname '吉吉企业测试' -srcfolder "$out/dmg-content" -format UDZO "$dmg"
hdiutil verify "$dmg"
(cd "$out" && shasum -a 256 "$(basename "$dmg")") > "$out/SHA256SUMS.txt"
echo "Enterprise test package: $dmg"
