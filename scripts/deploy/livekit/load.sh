#!/usr/bin/env bash
set -euo pipefail

: "${LIVEKIT_URL:?需要隔离测试实例的控制端点}"
: "${LIVEKIT_API_KEY:?需要测试密钥}"
: "${LIVEKIT_API_SECRET:?需要测试密钥}"
: "${HEALTH_URL:?需要同期 Hono 健康检查地址}"
: "${LIVEKIT_PID:?需要本机测试实例 PID}"
: "${LIVEKIT_INTERFACE:?需要测试网卡名}"
export LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET

room="ck-capacity-$(date +%s)"
loadpid=
cleanup() {
  if [[ -n "$loadpid" ]]; then kill "$loadpid" 2>/dev/null || true; fi
  lk room delete "$room" >/dev/null 2>&1 || true
}
trap cleanup EXIT
lk room create --empty-timeout 120 "$room" >/dev/null
lk load-test --room "$room" --duration "${DURATION:-15m}" --video-publishers 2 \
  --audio-publishers 1 --subscribers "${LOAD_SUBSCRIBERS:-28}" --num-per-second 10 --video-codec vp8 --layout 3x3 &
loadpid=$!
while kill -0 "$loadpid" 2>/dev/null; do
  printf '======== %s\n' "$(date -Is)"
  ps -p "$LIVEKIT_PID" -o etimes=,pcpu=,rss=
  awk -v iface="$LIVEKIT_INTERFACE:" '$1 == iface { print $1, "rx_bytes=" $2, "tx_bytes=" $10, "rx_drops=" $5, "tx_drops=" $13; found=1 } END { if (!found) exit 1 }' /proc/net/dev
  curl --fail --silent --show-error --max-time 5 --write-out 'health=%{http_code},seconds=%{time_total}\n' \
    --output /dev/null "$HEALTH_URL"
  sleep 15
done
wait "$loadpid"
loadpid=
