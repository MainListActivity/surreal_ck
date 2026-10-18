#!/usr/bin/env bash
# 前端定向恢复准入门禁（CI 验证作业，只读）：不接触 origin 主机、不写生产。
# 必需环境变量：RELEASE_SHA、ORIGIN_SHA、ORIGIN_VERIFIED_AT、APPROVAL_REF、GITHUB_REPOSITORY、GH_TOKEN。
# 可选：MAIN_REF（默认 origin/main）、ORIGIN_HEALTH_URL、MAX_ORIGIN_AGE_SEC（默认 1800）、NOW_EPOCH（测试注入）。
#
# 说明：公开入口无法读取 origin 运行 SHA（/api/ops/runtime-version 需要运营会话）。
# 因此 origin SHA 由运营只读核定后以 ORIGIN_SHA/ORIGIN_VERIFIED_AT/APPROVAL_REF 提交，
# 本门禁强制：目标等于该 SHA、核定时间新鲜、目标已合入 main、Quality gate 成功、origin 健康探测通过。
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
[[ "${APPROVAL_REF:-}" =~ ^[A-Za-z0-9._:/#-]{4,120}$ ]] || fail "approval_ref is missing or malformed"
[[ "${ORIGIN_VERIFIED_AT:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "origin_verified_at must be UTC in the form YYYY-MM-DDTHH:MM:SSZ"

verified=$(python3 -c 'import sys, datetime as d; print(int(d.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=d.timezone.utc).timestamp()))' "$ORIGIN_VERIFIED_AT") \
  || fail "origin_verified_at does not parse"
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

curl --fail --silent --show-error --max-time 15 "$health_url" \
  | jq -e '.status == "ok" and .surrealdb == "up"' >/dev/null \
  || fail "origin health probe is not ok; frontend is not published"

echo "frontend recovery gate passed: release=$RELEASE_SHA origin=$ORIGIN_SHA approval=$APPROVAL_REF verified_age=${age}s"
