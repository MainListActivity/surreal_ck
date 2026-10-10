#!/usr/bin/env bash
# 在生产主机上托管一次 origin 发布，使其与发起它的 SSH 会话解耦：
# 通道断连（SIGHUP、客户端死亡、CI job 中止）不影响已认领的发布收尾——
# healthy() 轮询与失败时的 rollback() 都在远端无人值守执行完毕。
#
# 用法：origin-release-runner.sh launch|status|log <release-id> [...]
#
#   launch <release-id> <release-script> <archive> [env-additions]
#     spawn 一个分离的 run 子进程（nohup+setsid、stdin=/dev/null），等它创建
#     job 目录后返回。可安全重发：run 子进程用 mkdir 原子认领 job，后到者
#     attach 到同一次发布而不会重入执行。
#   status <release-id>
#     打印当前状态并退出：success | failed:<rc|reason> | running |
#     failed:runner_not_started | failed:runner_lost。result 文件是唯一终态
#     权威；进程存活探测只用于区分「还在跑」和「runner 死掉没写终态」。
#   log <release-id> [lines]
#     打印 job 的 output.log 末尾（默认 250 行），供 CI 回收审计日志。
#
# job 目录：$ORIGIN_ROOT/deploy-jobs/<release-id>/（mode 700）
#   result      终态，tmp+mv 原子写入，存在即结束
#   output.log  发布全程 stdout/stderr，断连后仍可审计
#   run.pid     run 子进程 pid，供 status 存活探测
set -euo pipefail

action=${1:?action required}
release_id=${2:?release id required}
[[ "$release_id" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'invalid release id' >&2; exit 2; }
root=${ORIGIN_ROOT:-/home/ubuntu/surreal_ck}
job="$root/deploy-jobs/$release_id"

case "$action" in
  launch)
    release_script=${3:?release script required}
    archive=${4:?archive required}
    env_additions=${5:-}
    mkdir -p "$root/deploy-jobs"
    chmod 700 "$root/deploy-jobs"
    # 只有分离子进程能认领 job 目录：若 SSH 在 spawn 之前死亡则无人认领，
    # 下一次 launch 可以安全重试。
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
        </dev/null >/dev/null 2>&1 &
    else
      # macOS 测试机没有 setsid；生产 Ubuntu 走上面的分支。
      nohup bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
        </dev/null >/dev/null 2>&1 &
    fi
    # 认领确认 = 分离子进程真的创建了 job 目录。多个并发 launch 可能都
    # spawn 了子进程，但只有一个能 mkdir 成功。
    for _ in $(seq 1 50); do
      if [ -d "$job" ]; then
        echo 'release job accepted'
        exit 0
      fi
      sleep 0.1
    done
    echo 'release job did not start' >&2
    exit 1
    ;;
  run)
    release_script=${3:?release script required}
    archive=${4:?archive required}
    env_additions=${5:-}
    mkdir -p "$root/deploy-jobs"
    mkdir "$job" 2>/dev/null || exit 0
    chmod 700 "$job"
    echo $$ >"$job/run.pid"
    exec >"$job/output.log" 2>&1
    # 任何退出路径都清理输入文件（env_additions 含 secret）；没写出终态的
    # 退出补记 runner_aborted，让 status 轮询能收敛而不是永远 running。
    trap 'rc=$?; [ -z "$env_additions" ] || rm -f "$env_additions"; rm -f "$release_script"; if [ ! -f "$job/result" ]; then printf "%s\n" "failed:runner_aborted" >"$job/result.next"; mv -f "$job/result.next" "$job/result"; fi; exit "$rc"' EXIT
    # CI 轮询超时放弃后，新的发布不得与本 job 重叠执行。
    # 生产 Ubuntu 有 flock；本地 macOS 测试一次只跑一个 job。
    if command -v flock >/dev/null 2>&1; then
      exec 9>"$root/deploy-jobs/release.lock"
      if ! flock -n 9; then
        result=failed:release_busy
      fi
    fi
    if [ "${result:-}" = failed:release_busy ]; then
      :
    elif bash "$release_script" "$release_id" "$archive" "$env_additions"; then
      result=success
    else
      result="failed:$?"
    fi
    printf '%s\n' "$result" >"$job/result.next"
    mv -f "$job/result.next" "$job/result"
    # job 目录随发布积累；只修剪 CI 命名的旧 job，保留最近 16 个
    # （正在运行的 job 一定最新，不会被误删）。
    ls -1dt "$root"/deploy-jobs/*/ 2>/dev/null | tail -n +17 | while read -r old; do
      rm -rf "$old"
    done
    ;;
  status)
    if [ -f "$job/result" ]; then
      cat "$job/result"
    elif [ ! -d "$job" ]; then
      echo 'failed:runner_not_started'
    elif [ -f "$job/result.next" ]; then
      # result.next 存在而 result 不存在：run 正在写终态的瞬间。
      echo running
    elif [ -f "$job/run.pid" ]; then
      if kill -0 "$(cat "$job/run.pid")" 2>/dev/null; then
        echo running
      else
        echo 'failed:runner_lost'
      fi
    elif command -v flock >/dev/null 2>&1; then
      # run.pid 缺失只可能是 run 在 mkdir 后立即死亡（微秒级窗口）；
      # 用全局锁探测：锁被占说明有 run 在跑（可能是别的 job），保守报 running。
      if flock -n "$root/deploy-jobs/release.lock" -c true 2>/dev/null; then
        echo 'failed:runner_lost'
      else
        echo running
      fi
    else
      # 无 flock 又无 pid 文件（不应发生）：无法证伪，CI 截止时间兜底。
      echo running
    fi
    ;;
  log)
    if [ -f "$job/output.log" ]; then
      tail -n "${3:-250}" "$job/output.log"
    else
      echo "no output.log for $release_id" >&2
      exit 1
    fi
    ;;
  *)
    echo 'invalid action' >&2
    exit 2
    ;;
esac
