#!/usr/bin/env bash
# 前端定向恢复准入门禁（CI 验证作业，只读）：不接触 origin 主机、不写生产、不读取 PR 评论。
# 必需环境变量：RELEASE_SHA、EVIDENCE_PR、APPROVAL_REF、RELEASE_APPROVER_LOGINS、GITHUB_REPOSITORY、GH_TOKEN。
# 可选：MAIN_REF（默认 origin/main）、ORIGIN_HEALTH_URL（默认 https://l.maplayer.top/health）。
#
# origin 运行 SHA 不在本门禁读取：CI 无法读取它（公开入口没有，/api/ops/runtime-version 需要运营会话）。
# 运营在发布作业生成 barrier 之后只读核定 origin，并在证据 PR 上发表评论；发布作业内由
# scripts/deploy/origin-verification.py 逐项绑定校验评论与 barrier（见 runbook）。
set -euo pipefail

fail() {
  echo "::error::frontend recovery refused: $*" >&2
  exit 1
}

main_ref=${MAIN_REF:-origin/main}
health_url=${ORIGIN_HEALTH_URL:-https://l.maplayer.top/health}

[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "release_sha must be a full lowercase commit SHA"
[[ "${EVIDENCE_PR:-}" =~ ^[1-9][0-9]{0,8}$ ]] || fail "evidence_pr must be the PR number that carries the operator evidence"
[[ "${APPROVAL_REF:-}" =~ ^[A-Za-z0-9._:-]{4,128}$ ]] \
  || fail "approval_ref is missing or malformed (expects the fa operation audit reference)"

approvers=${RELEASE_APPROVER_LOGINS:-}
[ -n "${approvers//[[:space:],]/}" ] || fail "RELEASE_APPROVER_LOGINS is not configured; the operator evidence cannot be verified"

git cat-file -e "${RELEASE_SHA}^{commit}" 2>/dev/null || fail "$RELEASE_SHA is not a commit in this repository"
git merge-base --is-ancestor "$RELEASE_SHA" "$main_ref" || fail "$RELEASE_SHA is not merged into $main_ref"

# 证据 PR 必须存在。这里只读 PR 元数据，不读取评论。
if ! pr_number=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${EVIDENCE_PR}" --jq '.number'); then
  fail "evidence PR #${EVIDENCE_PR} is not readable in this repository"
fi
[ "$pr_number" = "$EVIDENCE_PR" ] || fail "evidence PR #${EVIDENCE_PR} does not exist"

if ! passed=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${RELEASE_SHA}/check-runs" \
  --jq 'any(.check_runs[]; .name == "Quality gate" and .conclusion == "success")'); then
  fail "could not read check runs for $RELEASE_SHA"
fi
[ "$passed" = "true" ] || fail "Quality gate has not succeeded for $RELEASE_SHA"

curl --fail --silent --show-error --max-time 15 "$health_url" \
  | jq -e '.status == "ok" and .surrealdb == "up"' >/dev/null \
  || fail "origin health probe is not ok; frontend is not published"

echo "frontend recovery gate passed: release=$RELEASE_SHA evidence_pr=$EVIDENCE_PR approval=$APPROVAL_REF"
