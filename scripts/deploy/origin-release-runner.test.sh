#!/usr/bin/env bash
# origin-release-runner + origin-release.sh 的 SSH 断连受控演练。
#
# 每个用例把 runner launch 放进一个独立 session（模拟 SSH 会话），在发布
# 飞行中向该会话进程组发 SIGHUP 并 -9 会话首领（等价于通道死亡）。断言
# 分离的 run 子进程不受影响、发布按语义收尾、终态与全程日志落盘可审计。
#
# 覆盖：
#   T1 成功路径：通道死于 pre-start 窗口 → 发布仍完整跑完并切 current。
#   T2 回滚路径：通道死于 healthy() 轮询窗口 → rollback 完整收尾
#      （env 恢复、current 回指、服务重启、二次健康检查、终态 failed:1）。
#   T3 launch 在 spawn 前死亡 → 重发幂等认领；并发 launch 只执行一次。
#   T4 终态探测：未知 id → runner_not_started；run 被 -9 → runner_lost。
#
# 只替换 sudo/systemctl/curl/sleep/mv 等外部命令，发布脚本主体原样执行。
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
test_root=$(mktemp -d)
export ORIGIN_ROOT="$test_root/origin"
export ORIGIN_ENV_FILE="$test_root/server.env"
export ORIGIN_HEALTH_URL=http://127.0.0.1:8080/health
export ORIGIN_SERVICE=fixture-svc
export TEST_ROOT="$test_root"
export TEST_SERVICE_STATE="$test_root/service-state"
export HOME="$test_root/home"
export PATH="$test_root/bin:$PATH"
export REVOCATION_GATE_DRAIN_SEC=0
RUNNER_SH="$script_dir/origin-release-runner.sh"

trap 'rc=$?; if [ "$rc" -ne 0 ]; then for d in "$ORIGIN_ROOT"/deploy-jobs/*/; do [ -d "$d" ] || continue; echo "===== $d/output.log =====" >&2; cat "$d/output.log" >&2 2>/dev/null || true; done; fi; rm -rf "$test_root"' EXIT

mkdir -p "$ORIGIN_ROOT/releases" "$test_root/bin" "$HOME/.bun/bin" "$test_root/payload"
printf '%s\n' running >"$TEST_SERVICE_STATE"
printf 'FAKE=1\n' >"$ORIGIN_ENV_FILE"

# 与 server/src/deploy/origin-release-gate.test.ts 相同的门禁兼容夹具：
# 试用来源显式闭约 + LCA14 消费/终止下限 + 撤销过滤标记，三道门禁直接放行。
make_compat_tree() {
  local base=$1
  mkdir -p "$base/server/src/routes" "$base/server/src/ai-allowance" \
    "$base/server/src/product-entitlement" "$base/shared/src" \
    "$base/shared/sql/system" "$base/shared/sql/workspace-template"
  printf '%s\n' 'return c.json({ error: { code: "workspace-commercial-source-required" } });' \
    >"$base/server/src/routes/workspaces.ts"
  printf '%s\n' '// gated by pro_trial_configuration' 'export function createProTrialRoutes() {}' \
    >"$base/server/src/routes/pro-trial.ts"
  printf '%s\n' '.route("/", createProTrialRoutes(service));' >"$base/server/src/app.ts"
  printf '%s\n' 'AI_ALLOWANCE_CONSUMABLE_SQL' >"$base/shared/src/ai-allowance.ts"
  printf '%s\n' '// structure' >"$base/shared/sql/system/027-ai-trial-conversion-source.surql"
  printf '%s\n' '// structure' >"$base/shared/sql/workspace-template/047-ai-source-termination.surql"
  printf '%s\n' 'aiAllowancePlanPrefix' 'WHERE AI_ALLOWANCE_CONSUMABLE_SQL' 'WHERE AI_ALLOWANCE_CONSUMABLE_SQL' \
    >"$base/server/src/ai-allowance/service.ts"
  printf '%s\n' 'plan-cycle-rules-v4 conversion.sourceId' >"$base/server/src/ai-allowance/plan-cycle.ts"
  printf '%s\n' 'content_grant_revocation' >"$base/server/src/product-entitlement/store.ts"
}

prev="$ORIGIN_ROOT/releases/prev-ga1"
make_compat_tree "$prev"
ln -s "$prev" "$ORIGIN_ROOT/current"

payload="$test_root/payload"
make_compat_tree "$payload"
mkdir -p "$payload/scripts/deploy"
cat >"$payload/scripts/deploy/origin-pre-start.sh" <<'SH'
#!/usr/bin/env bash
/bin/sleep 1
printf '%s\n' done >>"$ORIGIN_ROOT/hook-completed"
SH
chmod +x "$payload/scripts/deploy/origin-pre-start.sh"
tar -czf "$test_root/archive-src.tar.gz" -C "$payload" .
cp "$script_dir/origin-release.sh" "$test_root/release-src.sh"

cat >"$test_root/bin/bunx" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$test_root/bin/sudo" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = -n ] && shift
exec "$@"
SH
cat >"$test_root/bin/systemctl" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  stop) printf '%s\n' stopped >"$TEST_SERVICE_STATE" ;;
  start|restart) printf '%s\n' running >"$TEST_SERVICE_STATE" ;;
  is-active) state=$(cat "$TEST_SERVICE_STATE"); printf '%s\n' "$state"; [ "$state" = running ] ;;
esac
exit 0
SH
cat >"$test_root/bin/journalctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
# curl 按 health-mode 模拟服务健康：always 一律 ok；only-target 仅当 current
# 规范化后等于 healthy-target 文件记录的启动前目标时才 ok——用于让 healthy()
# 在新 release 上永不通过、而回滚恢复上一个 current 后转好。
cat >"$test_root/bin/curl" <<'SH'
#!/usr/bin/env bash
mode=$(cat "$TEST_ROOT/health-mode" 2>/dev/null || printf 'always')
target=$(readlink -f "$ORIGIN_ROOT/current" 2>/dev/null || printf 'none')
case "$mode" in
  always) ;;
  only-target) [ "$target" = "$(cat "$TEST_ROOT/healthy-target" 2>/dev/null)" ] || exit 7 ;;
esac
printf '%s\n' '{"status":"ok","surrealdb":"up"}'
SH
cat >"$test_root/bin/mv" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = -T ]; then
  shift
  /bin/rm -f "$2"
  exec /bin/mv -f "$@"
fi
exec /bin/mv "$@"
SH
# 压缩 healthy() 的 30 轮轮询到 ~1.8s：既留出让驱动程序在窗口内下手的
# 时间，又不拖慢整套演练。驱动自身的等待一律用 /bin/sleep 真值。
cat >"$test_root/bin/sleep" <<'SH'
#!/usr/bin/env bash
exec /bin/sleep 0.05
SH
chmod +x "$test_root/bin/"*
ln -s "$test_root/bin/bunx" "$HOME/.bun/bin/bunx"

setsid_exec() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'setsid() != -1 or die "setsid failed: $!"; exec @ARGV' "$@"
  else
    python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
  fi
}

job() { printf '%s\n' "$ORIGIN_ROOT/deploy-jobs/$1"; }

wait_file() {
  local deadline=$((SECONDS + ${2:-20}))
  while [ ! -e "$1" ]; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "wait_file timed out: $1" >&2; return 1; }
    /bin/sleep 0.05
  done
}

wait_log() {
  local deadline=$((SECONDS + ${3:-30}))
  while :; do
    [ -f "$2" ] && grep -q "$1" "$2" && return 0
    [ "$SECONDS" -lt "$deadline" ] || { echo "wait_log timed out: $1 in $2" >&2; return 1; }
    /bin/sleep 0.05
  done
}

# 在独立 session 中跑 runner launch（模拟 ssh exec 会话）：launch 返回后
# 会话首领 sleep 占位保持「通道」。返回通道目录，pgid 文件第一行是首领 pid
# （= 新 session 的进程组 id）。
new_channel() {
  local dir="$TEST_ROOT/chan-$5"
  mkdir -p "$dir"
  (
    export CHAN_DIR="$dir" RID="$1" REL_SH="$2" ARCHIVE="$3" ENVADD="$4" RUNNER_SH
    setsid_exec bash -c '
      printf "%s\n" $$ >"$CHAN_DIR/pgid"
      bash "$RUNNER_SH" launch "$RID" "$REL_SH" "$ARCHIVE" "$ENVADD" \
        >"$CHAN_DIR/launch.out" 2>"$CHAN_DIR/launch.err"
      printf "launch-rc=%s\n" "$?" >>"$CHAN_DIR/pgid"
      exec /bin/sleep 600
    '
  ) >/dev/null 2>&1 </dev/null &
  printf '%s\n' "$dir"
}

# 等价于 SSH 通道死亡：SIGHUP 打向会话进程组（ssh 断连的信号传播路径），
# 再 -9 会话首领（客户端消失）。分离的 run 子进程不该被波及。
kill_channel() {
  local pgid
  pgid=$(head -n1 "$1/pgid")
  kill -HUP -"$pgid" 2>/dev/null || true
  /bin/sleep 0.05
  kill -9 "$pgid" 2>/dev/null || true
}

final_status() {
  local s deadline=$((SECONDS + 40))
  while :; do
    s=$(bash "$RUNNER_SH" status "$1")
    [ "$s" = running ] || { printf '%s\n' "$s"; return 0; }
    [ "$SECONDS" -lt "$deadline" ] || { echo "status wait timed out for $1" >&2; return 1; }
    /bin/sleep 0.1
  done
}

# T1：通道死于 pre-start 停服窗口——发布仍须无人值守跑完。
printf 'always\n' >"$TEST_ROOT/health-mode"
printf 'NEW_K=v9\n' >"$TEST_ROOT/env-1.additions"
cp "$test_root/release-src.sh" "$test_root/release-t1.sh"
cp "$test_root/archive-src.tar.gz" "$test_root/archive-t1.tar.gz"
chan=$(new_channel test-cia "$test_root/release-t1.sh" "$test_root/archive-t1.tar.gz" "$TEST_ROOT/env-1.additions" t1)
wait_file "$chan/pgid"
wait_log 'pre-start hook' "$(job test-cia)/output.log"
kill_channel "$chan"
[ "$(final_status test-cia)" = success ]
[ "$(cat "$ORIGIN_ROOT/hook-completed")" = done ]
[ "$(cat "$TEST_SERVICE_STATE")" = running ]
[ "$(readlink "$ORIGIN_ROOT/current")" = "$ORIGIN_ROOT/releases/test-cia" ]
grep -q '^NEW_K=v9$' "$ORIGIN_ENV_FILE"
grep -q 'release test-cia healthy' "$(job test-cia)/output.log"
echo 'T1 pass: release completed hook/switch/restart/health after channel death'

# T2：通道死于 healthy() 轮询窗口——rollback 必须完整收尾。
# only-target：新 release 永不健康；回滚指回启动前的 current 后转好。
printf 'only-target\n' >"$TEST_ROOT/health-mode"
prev_canon=$(readlink -f "$ORIGIN_ROOT/current")
printf '%s\n' "$prev_canon" >"$TEST_ROOT/healthy-target"
env_before=$(cat "$ORIGIN_ENV_FILE")
printf 'BAD_K=must-not-stay\n' >"$TEST_ROOT/env-2.additions"
cp "$test_root/release-src.sh" "$test_root/release-t2.sh"
cp "$test_root/archive-src.tar.gz" "$test_root/archive-t2.tar.gz"
chan=$(new_channel test-cib "$test_root/release-t2.sh" "$test_root/archive-t2.tar.gz" "$TEST_ROOT/env-2.additions" t2)
wait_file "$chan/pgid"
wait_log 'switching' "$(job test-cib)/output.log"
/bin/sleep 0.2   # 落进 healthy() 轮询窗口（30 轮 × ~60ms ≈ 1.8s）
mid=$(bash "$RUNNER_SH" status test-cib)
kill_channel "$chan"
st=$(final_status test-cib)
[ "$mid" = running ]
case "$st" in failed:*) ;; *) echo "expected failed:* terminal status, got $st" >&2; exit 1 ;; esac
[ "$(cat "$(job test-cib)/result")" = 'failed:1' ]
[ "$(readlink -f "$ORIGIN_ROOT/current")" = "$prev_canon" ]
[ "$(cat "$ORIGIN_ENV_FILE")" = "$env_before" ]
[ "$(cat "$TEST_SERVICE_STATE")" = running ]
grep -q 'health check failed' "$(job test-cib)/output.log"
grep -q 'restored' "$(job test-cib)/output.log"
echo 'T2 pass: rollback restored env/current/service after channel death in health window'

# T3：launch 在 spawn 分离子进程之前死亡 → job 未认领，重发可接管；
# 并发重发只有一个真正执行。
cat >"$test_root/bin/chmod" <<'SH'
#!/usr/bin/env bash
if [ "${INJECT_BEFORE_SPAWN:-}" = 1 ] && [ "${2:-}" = "$ORIGIN_ROOT/deploy-jobs" ] && [ ! -e "$ORIGIN_ROOT/injected" ]; then
  touch "$ORIGIN_ROOT/injected"
  kill -9 "$PPID"
fi
exec /bin/chmod "$@"
SH
chmod +x "$test_root/bin/chmod"
cat >"$TEST_ROOT/release3.sh" <<'SH'
#!/usr/bin/env bash
printf 'run\n' >>"$ORIGIN_ROOT/executions2"
/bin/sleep 0.3
SH
INJECT_BEFORE_SPAWN=1 bash "$RUNNER_SH" launch test-cic \
  "$TEST_ROOT/release3.sh" "$TEST_ROOT/unused-archive" '' >/dev/null 2>&1 || true
[ ! -e "$(job test-cic)" ]

bash "$RUNNER_SH" launch test-cic "$TEST_ROOT/release3.sh" "$TEST_ROOT/unused-archive" '' >/dev/null &
first=$!
bash "$RUNNER_SH" launch test-cic "$TEST_ROOT/release3.sh" "$TEST_ROOT/unused-archive" '' >/dev/null &
second=$!
wait "$first"
wait "$second"
[ "$(final_status test-cic)" = success ]
[ "$(wc -l <"$ORIGIN_ROOT/executions2" | tr -d ' ')" = 1 ]
echo 'T3 pass: pre-spawn disconnect recovered; concurrent launch claimed the job once'

# T4：status 边界——未知 id 与 run 中途死（-9 无 EXIT trap）都要有确定答案。
[ "$(bash "$RUNNER_SH" status never-existed)" = 'failed:runner_not_started' ]
cat >"$TEST_ROOT/release4.sh" <<'SH'
#!/usr/bin/env bash
/bin/sleep 30
SH
bash "$RUNNER_SH" launch test-cid "$TEST_ROOT/release4.sh" "$TEST_ROOT/unused-archive" '' >/dev/null
wait_file "$(job test-cid)/run.pid"
run_pid=$(cat "$(job test-cid)/run.pid")
kill -9 "$run_pid"
deadline=$((SECONDS + 10))
while [ "$(bash "$RUNNER_SH" status test-cid)" = running ]; do
  [ "$SECONDS" -lt "$deadline" ] || { echo 'expected runner_lost' >&2; exit 1; }
  /bin/sleep 0.1
done
[ "$(bash "$RUNNER_SH" status test-cid)" = 'failed:runner_lost' ]
[ -n "$(bash "$RUNNER_SH" log test-cia 5)" ]
echo 'T4 pass: terminal probing distinguishes running / not_started / runner_lost'

echo 'all disconnect drills passed'
