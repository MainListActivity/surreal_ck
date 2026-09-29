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
    # Only the detached child may claim the job directory. If SSH dies before
    # spawning it, no claim exists and the next launch can safely retry.
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
        </dev/null >/dev/null 2>&1 &
    else
      # macOS test hosts lack setsid; production Ubuntu uses the branch above.
      nohup bash "$0" run "$release_id" "$release_script" "$archive" "$env_additions" \
        </dev/null >/dev/null 2>&1 &
    fi
    # Acknowledgement means a detached child actually claimed the job. Several
    # simultaneous launch calls may spawn, but only one child can mkdir it.
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
    mkdir "$job" 2>/dev/null || exit 0
    chmod 700 "$job"
    exec >"$job/output.log" 2>&1
    trap 'if [ ! -f "$job/result" ]; then printf "%s\n" failed:runner_aborted >"$job/result.next"; mv -f "$job/result.next" "$job/result"; fi' EXIT
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
    elif [ ! -d "$job" ]; then
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
