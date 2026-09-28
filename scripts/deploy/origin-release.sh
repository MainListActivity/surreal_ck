#!/usr/bin/env bash
# 在生产主机上执行：解包发布、安装生产依赖、切换 current、重启 systemd，健康检查失败自动回滚。
# 用法：origin-release.sh <release-id> <archive.tar.gz>
set -euo pipefail

release_id=$1
archive=$2
root=${ORIGIN_ROOT:-/home/ubuntu/surreal_ck}
service=${ORIGIN_SERVICE:-surreal-ck-hono}
health_url=${ORIGIN_HEALTH_URL:-http://127.0.0.1:8080/health}
keep=${ORIGIN_KEEP_RELEASES:-8}
export PATH="$HOME/.bun/bin:$PATH"

release="$root/releases/$release_id"
previous=$(readlink -f "$root/current")

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$health_url" 2>/dev/null | grep -q '"status":"ok","surrealdb":"up"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

switch_to() {
  ln -sfn "$1" "$root/current.next"
  mv -T "$root/current.next" "$root/current"
  sudo -n systemctl restart "$service"
}

rm -rf "$release"
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
rm -f "$archive"
(cd "$release" && bunx pnpm@10.32.1 install --frozen-lockfile --prod --config.confirmModulesPurge=false)

echo "switching $previous -> $release"
switch_to "$release"
if healthy; then
  echo "release $release_id healthy"
else
  echo "release $release_id failed health check; rolling back to $previous" >&2
  sudo -n journalctl -u "$service" -n 40 --no-pager >&2 || true
  switch_to "$previous"
  healthy && echo "rolled back to $previous" >&2
  exit 1
fi

# 只清理 CI 生成的旧发布（名字带 -ci），保留最近 $keep 个；手工发布目录不动。
ls -1dt "$root"/releases/*-ci* 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  [ "$(readlink -f "$root/current")" = "$old" ] || rm -rf "$old"
done
