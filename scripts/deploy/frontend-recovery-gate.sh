#!/usr/bin/env bash
# 前端定向恢复准入门禁（CI 验证作业，只读）：不接触 origin 主机、不写生产。
# 必需环境变量：RELEASE_SHA、ORIGIN_SHA、ORIGIN_VERIFIED_AT、APPROVAL_REF、RELEASE_APPROVER_LOGINS、GITHUB_REPOSITORY、GH_TOKEN。
# 可选：MAIN_REF（默认 origin/main）、ORIGIN_HEALTH_URL、MAX_ORIGIN_AGE_SEC（默认 1800）、NOW_EPOCH（测试注入）。
#
# 说明：公开入口无法读取 origin 运行 SHA（/api/ops/runtime-version 需要运营会话），因此 origin SHA 由运营只读核定后
# 以 ORIGIN_SHA / ORIGIN_VERIFIED_AT 提交；本门禁强制它与目标一致、核定时间新鲜。
# 运营批准必须可核查：APPROVAL_REF 为本仓库 issue 评论的数字 ID；评论作者须在 RELEASE_APPROVER_LOGINS 中
#（未配置即拒绝），正文须逐字包含目标 sha 与核定时间，且创建不早于核定时间。
set -euo pipefail

fail() {
  echo "::error::frontend recovery refused: $*" >&2
  exit 1
}

main_ref=${MAIN_REF:-origin/main}
health_url=${ORIGIN_HEALTH_URL:-https://l.maplayer.top/health}
max_age=${MAX_ORIGIN_AGE_SEC:-1800}

[[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "release_sha must be a full lowercase commit SHA"
[[ "${ORIGIN_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "origin_sha must be a full lowercase commit SHA"
[ "$RELEASE_SHA" = "$ORIGIN_SHA" ] || fail "frontend target $RELEASE_SHA differs from the operator-verified origin $ORIGIN_SHA"
[[ "${APPROVAL_REF:-}" =~ ^[0-9]{1,12}$ ]] || fail "approval_ref is missing or malformed (expects the numeric id of the operator approval comment)"
[[ "${ORIGIN_VERIFIED_AT:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "origin_verified_at must be UTC in the form YYYY-MM-DDTHH:MM:SSZ"

parse_utc() {
  python3 -c 'import sys, datetime as d; print(int(d.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=d.timezone.utc).timestamp()))' "$1"
}

verified=$(parse_utc "$ORIGIN_VERIFIED_AT") || fail "origin_verified_at does not parse"
now=${NOW_EPOCH:-$(date -u +%s)}
age=$((now - verified))
if [ "$age" -lt -60 ] || [ "$age" -gt "$max_age" ]; then
  fail "origin verification is stale or in the future (age ${age}s, allowed 0..${max_age}s)"
fi

git cat-file -e "${RELEASE_SHA}^{commit}" 2>/dev/null || fail "$RELEASE_SHA is not a commit in this repository"
git merge-base --is-ancestor "$RELEASE_SHA" "$main_ref" || fail "$RELEASE_SHA is not merged into $main_ref"

if ! passed=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${RELEASE_SHA}/check-runs" \
  --jq 'any(.check_runs[]; .name == "Quality gate" and .conclusion == "success")'); then
  fail "could not read check runs for $RELEASE_SHA"
fi
[ "$passed" = "true" ] || fail "Quality gate has not succeeded for $RELEASE_SHA"

# 运营批准：评论必须存在于本仓库；作者在白名单中（大小写不敏感）；正文逐字包含目标 sha 与核定时间；
# 创建时间不早于核定时间（批准必须针对这次核定，不能复用更早的评论）。
approvers=${RELEASE_APPROVER_LOGINS:-}
[ -n "${approvers//[[:space:],]/}" ] || fail "RELEASE_APPROVER_LOGINS is not configured; the operator approval cannot be verified"
comment=$(gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${APPROVAL_REF}" 2>/dev/null) \
  || fail "approval comment $APPROVAL_REF is not readable in this repository"
author=$(printf '%s' "$comment" | jq -r '.user.login // empty')
body=$(printf '%s' "$comment" | jq -r '.body // empty')
created=$(printf '%s' "$comment" | jq -r '.created_at // empty')

author_lc=$(printf '%s' "$author" | tr '[:upper:]' '[:lower:]')
author_ok=0
IFS=',' read -r -a allowed <<<"$approvers"
for login in "${allowed[@]}"; do
  login_lc=$(printf '%s' "$login" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  if [ -n "$login_lc" ] && [ "$login_lc" = "$author_lc" ]; then author_ok=1; fi
done
[ "$author_ok" = 1 ] || fail "approval comment $APPROVAL_REF is not by an authorized approver"
grep -qF -- "$RELEASE_SHA" <<<"$body" || fail "approval comment does not name the release sha $RELEASE_SHA"
grep -qF -- "$ORIGIN_VERIFIED_AT" <<<"$body" || fail "approval comment does not name the origin verification time $ORIGIN_VERIFIED_AT"
created_epoch=$(parse_utc "$created") || fail "approval comment has no readable creation time"
[ "$created_epoch" -ge "$verified" ] || fail "approval comment predates the origin verification"

curl --fail --silent --show-error --max-time 15 "$health_url" \
  | jq -e '.status == "ok" and .surrealdb == "up"' >/dev/null \
  || fail "origin health probe is not ok; frontend is not published"

echo "frontend recovery gate passed: release=$RELEASE_SHA origin=$ORIGIN_SHA approval=$APPROVAL_REF verified_age=${age}s"
