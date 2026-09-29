#!/usr/bin/env bash
# Run one origin release independently of the SSH session that starts it.
# Usage: origin-release-runner.sh launch|status <release-id> [release-script archive env-additions]
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
    if mkdir "$job" 2>/dev/null; then
      chmod 700 "$job"
      # Every stream is detached, so ssh can close without terminating the release.
      if command -v setsid >/dev/null 2>&1; then
        nohup setsid bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
          </dev/null >"$job/output.log" 2>&1 &
      else
        # macOS test hosts lack setsid; production Ubuntu uses the branch above.
        nohup bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
          </dev/null >"$job/output.log" 2>&1 &
      fi
      printf '%s\n' "$!" >"$job/pid"
    fi
    echo 'release job accepted'
    ;;
  run)
    release_script=${3:?release script required}
    archive=${4:?archive required}
    env_additions=${5:-}
    # A CI polling timeout must not let a newer job overlap this remote job.
    # flock is present on the production Ubuntu host; local macOS tests run
    # one job at a time without it.
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
    rm -f "$env_additions" "$release_script"
    printf '%s\n' "$result" >"$job/result.next"
    mv -f "$job/result.next" "$job/result"
    ;;
  status)
    if [ -f "$job/result" ]; then
      cat "$job/result"
    elif [ ! -f "$job/pid" ]; then
      echo 'failed:runner_not_started'
    else
      # setsid may fork and exit its launcher PID before the release ends.
      # The result file is authoritative; the CI deadline handles a lost job.
      echo running
    fi
    ;;
  *)
    echo 'invalid action' >&2
    exit 2
    ;;
esac
