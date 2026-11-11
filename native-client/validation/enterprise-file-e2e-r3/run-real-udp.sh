#!/usr/bin/env bash
# 仅在已批准的真实OS UDP桌面运行；不构建，不换fork，不回退VNet/生产服务。
set -euo pipefail
: "${E2E_SOURCE_ROOT:?必须提供对应源码快照根目录}"
: "${E2E_TEST_BINARY:?必须提供本轮构建回执中的测试二进制}"
: "${E2E_TEST_SHA256:?必须提供本轮构建回执中的二进制SHA256}"
: "${SURREAL_TEST_BINARY:?必须提供已验证固定fork二进制}"
: "${SURREAL_TEST_SHA256:?必须提供固定fork二进制SHA256}"
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOG=${E2E_LOG:-"$HERE/real-udp-$(date -u +%Y%m%dT%H%M%SZ).log"}
check_hash() {
  local actual
  actual=$(sha256sum -- "$1")
  actual=${actual%% *}
  [[ "$actual" == "$2" ]] || { echo "二进制摘要不匹配，拒绝运行" >&2; return 1; }
}
check_hash "$E2E_TEST_BINARY" "$E2E_TEST_SHA256"
check_hash "$SURREAL_TEST_BINARY" "$SURREAL_TEST_SHA256"
python3 "$HERE/verify-inputs.py" --repo "$E2E_SOURCE_ROOT" --require-lock
# 只能运行两个指定忽略用例，防止误用旧二进制/过滤器导致0测试却退出0。
LIST=$("$E2E_TEST_BINARY" enterprise_file_e2e:: --ignored --list)
[[ "$LIST" == *"enterprise_file_e2e::authenticated_real_udp_file_confirm_hash_and_saved_ack: test"* ]]
[[ "$LIST" == *"enterprise_file_e2e::authenticated_revocation_stops_file_and_retains_previously_saved_receipt: test"* ]]
[[ $(printf '%s\n' "$LIST" | grep -c ': test$') -eq 2 ]]
export SURREAL_TEST_BINARY
set +e
"$E2E_TEST_BINARY" enterprise_file_e2e:: --ignored --test-threads=1 --nocapture 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e
# 无论测试是否失败，都再核对输入及运行文件，不能把源码漂移后的结果作为新版证明。
python3 "$HERE/verify-inputs.py" --repo "$E2E_SOURCE_ROOT" --require-lock
check_hash "$E2E_TEST_BINARY" "$E2E_TEST_SHA256"
check_hash "$SURREAL_TEST_BINARY" "$SURREAL_TEST_SHA256"
if [[ $status -ne 0 ]]; then exit "$status"; fi
grep -q 'test result: ok. 2 passed; 0 failed' "$LOG"
printf '通过两个真实文件用例；日志：%s\n' "$LOG"
