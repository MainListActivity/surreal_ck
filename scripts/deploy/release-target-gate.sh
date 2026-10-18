#!/usr/bin/env bash
# 发布目标准入门禁（origin 部署，CI 验证作业，只读）：目标提交必须是 origin/main 的祖先，且 Quality gate 成功。
# 自动路径（Deploy production）与手动路径（Deploy origin (manual)，含回滚目标）都经过本门禁，且发生在任何上传之前。
# 不接触 origin 主机，不读取 secrets。
# 必需环境变量：RELEASE_SHA、GITHUB_REPOSITORY、GH_TOKEN。
set -euo pipefail

fail() {
  echo "::error::release target refused: $*" >&2
  exit 1
}

[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "sha must be a full lowercase commit SHA"
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}

# compare main...sha：sha 是 main 的祖先（或即 main 头）时 status 为 behind 或 identical；其它状态一律拒绝。
if ! status=$(gh api "repos/${repo}/compare/main...${RELEASE_SHA}" --jq .status); then
  fail "could not compare $RELEASE_SHA with main"
fi
case "$status" in
  behind | identical) ;;
  *) fail "$RELEASE_SHA is not an ancestor of main (compare status: ${status:-unknown})" ;;
esac

if ! passed=$(gh api "repos/${repo}/commits/${RELEASE_SHA}/check-runs" \
  --jq 'any(.check_runs[]; .name == "Quality gate" and .conclusion == "success")'); then
  fail "could not read check runs for $RELEASE_SHA"
fi
[ "$passed" = "true" ] || fail "Quality gate has not succeeded for $RELEASE_SHA"

echo "release target gate passed: sha=$RELEASE_SHA main_relation=$status"
