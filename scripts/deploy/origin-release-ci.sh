#!/usr/bin/env bash
# CI 侧发布收敛：在 origin 上登记并以分离工作进程激活，再按主机状态文件判定结果。
# 用法：origin-release-ci.sh <release-id> <archive> <env-additions> <sha> <approval-ref> <deployment-id>
#   archive / env-additions 为 origin 上的暂存路径，由工作流先行 scp 上传（此时尚未停服）。
# 结果只以主机状态文件为准：SSH 断开、超时或状态不可读都不是成功，也不是已回滚。
# 重复调用安全：launch 幂等；已登记的 release 只回显状态；interrupted 时在主机接受 --recover 之前每轮请求（忙或结果未知时下一轮重试），接受后只等待主机状态。
# 退出码：0 healthy；1 失败（终态失败、请求被拒、或截止时结果仍未知——未知由运维读取主机状态判定）。
set -euo pipefail

release_id=${1:-}
archive=${2:-}
env_additions=${3:-}
sha=${4:-}
approval_ref=${5:-}
deployment_id=${6:-}
host=${ORIGIN_SSH_TARGET:-origin}
staging=${ORIGIN_STAGING_DIR:-/tmp}
deadline_sec=${ORIGIN_WATCH_DEADLINE_SEC:-1200}
interval_sec=${ORIGIN_WATCH_INTERVAL_SEC:-15}
remote_script="$staging/origin-release-${release_id}.sh"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
contacted=0
# 恢复请求是否已被主机接受：接受后同一运行再次出现 interrupted 只等待，不重复请求。
recover_accepted=0

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "sha must be a full lowercase commit SHA"
[[ "$release_id" =~ ^"${sha:0:7}"-ci[0-9]+$ ]] || fail "release id does not match the sha"
[[ "$approval_ref" =~ ^[A-Za-z0-9._:/#-]{4,120}$ ]] || fail "approval ref is missing or malformed"
[[ "$deployment_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "deployment id is missing or malformed"
[ "$archive" = "$staging/surreal_ck-${release_id}.tar.gz" ] || fail "archive is not the staged path"
[ "$env_additions" = "$staging/surreal_ck-env-${release_id}" ] || fail "env additions is not the staged path"

# 在 origin 上执行发布工具；参数逐个转义，远端 shell 不做二次展开。
origin_run() {
  local quoted=() arg
  for arg in "$@"; do
    quoted+=("$(printf '%q' "$arg")")
  done
  # 参数已由 printf %q 逐个转义，远端命令在本地展开是有意的。
  # shellcheck disable=SC2029
  ssh "${ssh_opts[@]}" "$host" "bash $(printf '%q' "$remote_script") ${quoted[*]}"
}

# 远端状态名；SSH 失败、脚本不可用或没有 state 行时返回空（未知：既不是成功，也不是回滚）。
state_of() {
  local out line
  out=$(origin_run --status "$release_id" 2>/dev/null) || return 0
  line=$(printf '%s\n' "$out" | grep -m1 '^state=' || true)
  line=${line#state=}
  printf '%s' "${line%% *}"
}

# 终态或截止时输出远端状态与日志末尾，便于在 CI 日志中判读。
show_remote() {
  origin_run --status "$release_id" 2>/dev/null || echo "status unavailable: origin not reachable"
  origin_run --log "$release_id" 2>/dev/null | tail -n 60 || true
}

remote_rm() {
  local quoted=() arg
  for arg in "$@"; do
    quoted+=("$(printf '%q' "$arg")")
  done
  # shellcheck disable=SC2029  # 同上：参数已逐个转义。
  ssh "${ssh_opts[@]}" "$host" "rm -f ${quoted[*]}" >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  set +e
  if [ "$contacted" = 1 ]; then
    # 终态与 absent：删除远端工具副本与本次运行上传的暂存件（含密钥）。终态时工作进程已清理自己的暂存件，
    # 这里删除的只能是本次运行重复上传的副本（同一 release id 的重跑会再次上传）。
    # 运行中或状态未知：保留，交由工作进程结束时清理，或由运维读取后处理。
    case "$(state_of)" in
      healthy|rolled-back|rollback-refused|rollback-failed|failed|refused|absent)
        remote_rm "$remote_script" "$archive" "$env_additions" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT

launch_request() {
  local rc=0 out other
  out=$(origin_run --launch "$release_id" "$archive" "$env_additions" "$sha" "$approval_ref" "$deployment_id" 2>&1) || rc=$?
  printf '%s\n' "$out"
  case "$rc" in
    0) echo "activation registered on origin for $release_id" ;;
    2) fail "origin rejected the activation request for $release_id (validation); see the message above" ;;
    75) echo "origin is busy with another activation; waiting" ;;
    76)
      other=$(printf '%s\n' "$out" | grep -m1 '^interrupted=' | cut -d= -f2- || true)
      if [ -n "$other" ] && [ "$other" != "$release_id" ]; then
        fail "origin has an interrupted activation $other; ops must run --recover $other before $release_id can start"
      fi
      echo "activation $release_id is interrupted; recovery is requested on the next poll" ;;
    *) echo "launch outcome unknown (rc=$rc); reading the host state on the next poll" ;;
  esac
}

recover_request() {
  local rc=0 out
  out=$(origin_run --recover "$release_id" 2>&1) || rc=$?
  printf '%s\n' "$out"
  case "$rc" in
    0) recover_accepted=1; echo "recovery requested on origin for $release_id" ;;
    75) echo "origin is busy; waiting" ;;
    255) echo "recovery request outcome unknown (ssh); reading the host state on the next poll" ;;
    *)
      # 拒绝前回读主机状态与日志（仅状态字段与阶段记录，不含 env 值），供 CI 日志判读；仍以 exit 1 结束。
      show_remote
      fail "origin refused recovery for $release_id (rc=$rc); ops must read the host state" ;;
  esac
}

# 从这里开始可能已接触 origin：清理阶段需要读取并收尾远端状态。
contacted=1
deadline=$((SECONDS + deadline_sec))
st=""
while :; do
  st=$(state_of)
  case "$st" in
    healthy)
      show_remote
      echo "release $release_id is healthy on origin"
      exit 0
      ;;
    rolled-back|rollback-refused|rollback-failed|failed|refused)
      show_remote
      fail "origin activation for $release_id ended in state '$st'; read the status above"
      ;;
    running)
      echo "origin activation $release_id is running" ;;
    interrupted)
      if [ "$recover_accepted" = 1 ]; then
        echo "recovery for $release_id was already accepted; waiting for the host state"
      else
        recover_request
      fi ;;
    absent)
      launch_request ;;
    "")
      echo "origin state not readable this round (ssh); waiting" ;;
    *)
      echo "origin state: $st; waiting" ;;
  esac

  if [ "$SECONDS" -ge "$deadline" ]; then
    show_remote
    fail "origin activation result unknown after ${deadline_sec}s (last state: ${st:-unreadable}); not treated as success or rollback; ops must read the host state for $release_id"
  fi
  sleep "$interval_sec"
done
