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

# LCA13 撤销兼容门禁：content_grant_revocation 是追加式撤销事实，只能由
# 含本门禁代码的 origin 进程经 entitlement.gift 能力端点写入。不含撤销
# 过滤的目标会把已撤销赠送静默复活（越权）。
#
# 语义：目标含过滤 → 放行。否则停掉 origin 服务（冻结唯一撤销写入路径），
# 静置 DRAIN_SEC 排空停服前已被引擎接收的 in-flight 写入，再用受控检查器
# 读 _system 撤销计数 → 有撤销或无法证明为空即拒绝；服务在「检查→调用方
# 完成切换并重启」全程保持停止。拒绝时本函数把服务拉回运行，调用方直接退出。
target_has_revocation_filter() {
  grep -rqs "content_grant_revocation" "$1/server/src/product-entitlement"
}

# 受控检查器定位：优先本次发布包，其次回退目标/current，再其次任何留存
# （keep 窗口内）的含门禁发布目录。全都没有 → 无法证明安全 → 拒绝。
find_revocation_checker_dir() {
  local d
  for d in "$release" "$previous" "$(readlink -f "$root/current" 2>/dev/null)" \
           $(ls -1dt "$root"/releases/*/ 2>/dev/null); do
    if [ -n "$d" ] && [ -f "$d/server/src/db/grant-revocation-check-cli.ts" ]; then
      printf '%s\n' "$d/server"
      return 0
    fi
  done
  return 1
}

# 撤销存在性受控检查：0=无撤销、1=有撤销、2=无法证明（失败按不安全处理）。
grant_revocations_present() {
  local server_dir="$1"
  local output
  if ! output=$(cd "$server_dir" \
    && bun run --env-file="$env_file" src/db/grant-revocation-check-cli.ts 2>&1); then
    echo "revocation gate: check command failed: $output" >&2
    return 2
  fi
  echo "revocation gate: $output (checker dir: $server_dir)" >&2
  case "$output" in
    *grant_revocations=0*) return 0 ;;
    *grant_revocations=[1-9]*) return 1 ;;
    *) return 2 ;;
  esac
}

require_revocation_compat() {
  local target="$1"
  if target_has_revocation_filter "$target"; then
    return 0
  fi
  echo "revocation gate: $target lacks revocation filtering; freezing writes (systemctl stop $service)" >&2
  sudo -n systemctl stop "$service"
  # 排空窗口：进程停止前已被引擎接收的撤销写入可能在停服后落库
  # （响应丢失但提交成功）。停服后先静置再查计数，覆盖该 in-flight 窗口。
  sleep "${REVOCATION_GATE_DRAIN_SEC:-3}"
  local server_dir=""
  local verdict=0
  if server_dir=$(find_revocation_checker_dir); then
    grant_revocations_present "$server_dir" || verdict=$?
  else
    echo "revocation gate: no revocation checker available on this host; cannot prove safety" >&2
    verdict=2
  fi
  if [ "$verdict" -ne 0 ]; then
    echo "revocation gate: refusing to activate $target" >&2
    # 拒绝激活：服务保持原 current 指向，拉回运行（即使带病也好过授权语义回退）。
    sudo -n systemctl start "$service" || true
    return 1
  fi
  # 服务保持停止：调用方随即完成 point_to + restart；冻结覆盖检查到切换全程。
}

rollback() {
  echo "release $release_id failed: $1; restoring $previous" >&2
  sudo -n journalctl -u "$service" -n 40 --no-pager >&2 || true
  if ! require_revocation_compat "$previous"; then
    echo "automatic rollback refused: $previous is not revocation-compatible" >&2
    exit 1
  fi
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

# 撤销兼容门禁：发布（含手动 Deploy origin 旧 sha）若目标不含撤销过滤，
# 仅在 _system 无撤销记录时才放行；判定拒绝时不动运行中服务直接退出。
if ! require_revocation_compat "$release"; then
  exit 1
fi

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
