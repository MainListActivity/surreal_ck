#!/usr/bin/env bash
# 在生产主机上执行：解包发布、安装生产依赖、同步环境变量、停写执行发布钩子、切换 current、重启 systemd。
# 健康检查失败时恢复上一个 current 与 server.env。
# 用法：origin-release.sh <release-id> <archive.tar.gz> [env-additions-file]
set -euo pipefail

release_id=$1
archive=$2
env_additions=${3:-}
root=${ORIGIN_ROOT:-/home/ubuntu/surreal_ck}
service=${ORIGIN_SERVICE:-surreal-ck-hono}
env_file=${ORIGIN_ENV_FILE:-/etc/surreal-ck/server.env}
health_url=${ORIGIN_HEALTH_URL:-http://127.0.0.1:8080/health}
keep=${ORIGIN_KEEP_RELEASES:-8}
export PATH="$HOME/.bun/bin:$PATH"

release="$root/releases/$release_id"
previous=$(readlink -f "$root/current")
env_dir="$root/backups/env"
env_backup="$env_dir/server.env.$release_id"

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$health_url" 2>/dev/null | grep -q '"status":"ok","surrealdb":"up"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

point_to() {
  ln -sfn "$1" "$root/current.next"
  mv -T "$root/current.next" "$root/current"
}

rollback() {
  echo "release $release_id failed: $1; restoring $previous" >&2
  sudo -n journalctl -u "$service" -n 40 --no-pager >&2 || true
  cat "$env_backup" > "$env_file"
  point_to "$previous"
  sudo -n systemctl restart "$service"
  healthy && echo "restored $previous" >&2
  exit 1
}

rm -rf "$release"
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
rm -f "$archive"
(cd "$release" && bunx pnpm@10.32.1 install --frozen-lockfile --prod --config.confirmModulesPurge=false)

# 环境变量：GitHub production Environment 里的 ORIGIN_ENV_<NAME> secret 写入 server.env 的 <NAME>，只增改这些键。
mkdir -p "$env_dir" && chmod 700 "$env_dir"
cat "$env_file" > "$env_backup" && chmod 600 "$env_backup"
if [ -n "$env_additions" ] && [ -s "$env_additions" ]; then
  while IFS= read -r line; do
    key=${line%%=*}
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "invalid env key" >&2; exit 1; }
    next="$env_dir/server.env.next"
    (umask 077; { grep -v "^${key}=" "$env_file" || true; printf '%s\n' "$line"; } > "$next")
    cat "$next" > "$env_file"
    rm -f "$next"
    echo "env: set $key"
  done < "$env_additions"
fi
[ -n "$env_additions" ] && rm -f "$env_additions"

# 发布钩子：发布代码里有 scripts/deploy/origin-pre-start.sh 时，停掉旧服务（冻结写入）后在新版本目录执行，
# 例如一次性数据复制迁移。钩子必须幂等，读取 $ORIGIN_ENV_FILE。
hook="$release/scripts/deploy/origin-pre-start.sh"
if [ -f "$hook" ]; then
  echo "stopping $service for pre-start hook"
  sudo -n systemctl stop "$service"
  if ! (cd "$release" && ORIGIN_ENV_FILE="$env_file" bash "$hook"); then
    rollback "pre-start hook failed"
  fi
fi

echo "switching $previous -> $release"
point_to "$release"
sudo -n systemctl restart "$service"
healthy || rollback "health check failed"
echo "release $release_id healthy"

# 只清理 CI 生成的旧发布与 env 备份，保留最近 $keep 个；手工发布目录不动。
ls -1dt "$root"/releases/*-ci* 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  [ "$(readlink -f "$root/current")" = "$old" ] || rm -rf "$old"
done
ls -1t "$env_dir"/server.env.*-ci* 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
