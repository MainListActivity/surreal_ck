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

# 拒绝/中止路径统一恢复 live env：先写临时文件再 mv 覆盖——若直接
# cat > $env_file，重定向会先于 cat 失败截断目标，把 env 清成空文件。
# 恢复失败显式中止（备份仍在 $env_backup 供人工排查），不静默留下
# 被增改的 env，否则原服务下次重启会读到一次被拒绝发布的配置。
restore_env() {
  local tmp="$env_file.restore.$$"
  # tmp 以默认 umask 创建；env_file 含密钥，恢复后权限收紧到与备份一致。
  if cat "$env_backup" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$env_file"; then
    return 0
  fi
  rm -f "$tmp"
  echo "release aborted: env restore failed; backup kept at $env_backup" >&2
  exit 1
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
  # 本函数在 if 条件中被调用，errexit 被抑制：stop 失败不会中断脚本，必须显式检查。
  # stop 报错但服务已不活跃（进程已死/已失败）同样是成立的冻结态可放行；
  # 服务仍活跃、或状态不可证明（is-active 查询失败/异常态）→ 冻结不成立 → 拒绝。
  if ! sudo -n systemctl stop "$service"; then
    local state
    state=$(systemctl is-active "$service" 2>/dev/null || true)
    if [ "$state" != "inactive" ] && [ "$state" != "failed" ]; then
      echo "revocation gate: systemctl stop $service failed and state='$state' (not confirmed stopped); refusing" >&2
      sudo -n systemctl start "$service" || echo "revocation gate: WARN failed to restore $service" >&2
      return 1
    fi
    echo "revocation gate: stop reported failure but $service is already $state; freeze holds" >&2
  fi
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
    sudo -n systemctl start "$service" || echo "revocation gate: WARN failed to restore $service" >&2
    return 1
  fi
  # 服务保持停止：调用方随即完成 point_to + restart；冻结覆盖检查到切换全程。
}

# LCA10 试用来源门禁：POST /api/workspaces 是公共创建入口。LCA10 之前的 origin
# 在 canCreate 成立后直接以隐式 trial 来源供应（路由内硬编码 resourceSource，
# 不读 pro_trial_configuration/pro_trial_eligibility）；把这样的旧 origin 回滚/
# 恢复为 current，会在人工处置前重新打开隐式试用创建。
#
# 语义断言（可执行、纯静态）——以正向契约为准，不是「没命中某种危险拼写」：
#   1) 公共创建入口处于显式关闭契约：workspaces.ts 必须命中
#      workspace-commercial-source-required（LCA10 起公共入口对创建一律 409
#      拒绝并指向显式入口）；
#   2) 公共创建入口不再发起任何工作区供应调用（直接/间接来源赋值都涵盖）；
#   3) 纵深防御：已知 trial 来源键值拼写（含冒号前后空白、引号/模板串变体）一律拒绝；
#   4) 显式受控试用入口在场且为配置驱动实现（pro-trial.ts 必须引用
#      pro_trial_configuration，占位文件不算），并被 app.ts 挂载。
# 目标树缺失/不可读/检查命令出错一律 fail-closed 拒绝。本门禁不做存活探测、
# 不停服、无副作用：必须先于任何主机状态变更（env 增改/停服/切换）执行，
# 拒绝时 env/current/服务保持原状。
target_has_explicit_trial_source() {
  local target="$1"
  local route="$target/server/src/routes/workspaces.ts"
  local trial_entry="$target/server/src/routes/pro-trial.ts"
  local app_entry="$target/server/src/app.ts"
  [ -f "$route" ] || { echo "trial gate: $route missing; cannot prove creation semantics" >&2; return 1; }
  [ -f "$trial_entry" ] || { echo "trial gate: $trial_entry missing; target has no explicit trial entry" >&2; return 1; }
  [ -f "$app_entry" ] || { echo "trial gate: $app_entry missing; cannot prove trial entry is mounted" >&2; return 1; }
  local verdict=0
  grep -Eq 'workspace-commercial-source-required' "$route" || verdict=$?
  if [ "$verdict" -ge 2 ]; then
    echo "trial gate: grep failed (rc=$verdict) on $route; cannot prove creation semantics" >&2
    return 1
  fi
  if [ "$verdict" -eq 1 ]; then
    echo "trial gate: $route lacks the explicit closure contract (workspace-commercial-source-required)" >&2
    return 1
  fi
  verdict=0
  grep -Eq '(^|[^A-Za-z0-9_])createWorkspace[[:space:]]*\(' "$route" || verdict=$?
  if [ "$verdict" -ge 2 ]; then
    echo "trial gate: grep failed (rc=$verdict) on $route; cannot prove creation semantics" >&2
    return 1
  fi
  if [ "$verdict" -eq 0 ]; then
    echo "trial gate: $route still issues workspace provisioning calls from the public entry" >&2
    return 1
  fi
  verdict=0
  grep -Eq '(planKey|sourceKind|resourceSource)[[:space:]]*:[[:space:]]*["'"'"'`]trial["'"'"'`]' "$route" || verdict=$?
  if [ "$verdict" -ge 2 ]; then
    echo "trial gate: grep failed (rc=$verdict) on $route; cannot prove creation semantics" >&2
    return 1
  fi
  if [ "$verdict" -eq 0 ]; then
    echo "trial gate: $route carries a trial source literal" >&2
    return 1
  fi
  verdict=0
  grep -Eq 'pro_trial_configuration' "$trial_entry" || verdict=$?
  if [ "$verdict" -ge 2 ]; then
    echo "trial gate: grep failed (rc=$verdict) on $trial_entry; cannot prove trial entry semantics" >&2
    return 1
  fi
  if [ "$verdict" -eq 1 ]; then
    echo "trial gate: $trial_entry is not configuration-driven (pro_trial_configuration absent)" >&2
    return 1
  fi
  verdict=0
  grep -Eq 'createProTrialRoutes' "$app_entry" || verdict=$?
  if [ "$verdict" -ge 2 ]; then
    echo "trial gate: grep failed (rc=$verdict) on $app_entry; cannot prove trial entry is mounted" >&2
    return 1
  fi
  if [ "$verdict" -eq 1 ]; then
    echo "trial gate: $trial_entry exists but app.ts does not mount it" >&2
    return 1
  fi
  return 0
}

require_trial_source_compat() {
  if target_has_explicit_trial_source "$1"; then
    return 0
  fi
  echo "trial gate: refusing to activate $1 (would restore implicit trial creation)" >&2
  return 1
}

# LCA14 D2–D3 兼容下限：统一来源消费规则及转换终止协议必须一起在场。
# 只检查发布树，不读数据库。缺失即拒绝；禁止以旧 origin 恢复试用消费。
# 留存新增 schema/终止审计，不随代码回滚删除。首发若无兼容 previous，
# 健康失败保持当前安全版本/停写状态，不能自动启动不兼容版本。
require_allowance_source_compat() {
  local target="$1"
  local shared="$target/shared/src/ai-allowance.ts"
  local service="$target/server/src/ai-allowance/service.ts"
  local cycle="$target/server/src/ai-allowance/plan-cycle.ts"
  if [ -f "$shared" ] && [ -f "$service" ] && [ -f "$cycle" ] \
    && [ -f "$target/shared/sql/system/027-ai-trial-conversion-source.surql" ] \
    && [ -f "$target/shared/sql/workspace-template/047-ai-source-termination.surql" ] \
    && grep -q 'AI_ALLOWANCE_CONSUMABLE_SQL' "$shared" \
    && grep -q 'aiAllowancePlanPrefix' "$service" \
    && [ "$(grep -c 'WHERE.*AI_ALLOWANCE_CONSUMABLE_SQL' "$service")" -ge 2 ] \
    && grep -q 'plan-cycle-rules-v4' "$cycle" \
    && grep -q 'conversion.sourceId' "$cycle"; then
    return 0
  fi
  echo "allowance source gate: refusing to activate $target (missing LCA14 consumption/termination compatibility)" >&2
  return 1
}

rollback() {
  echo "release $release_id failed: $1; restoring $previous" >&2
  sudo -n journalctl -u "$service" -n 40 --no-pager >&2 || true
  # 先做纯静态的试用来源检查（无副作用）：拒绝时 env/current/服务均未被触碰。
  if ! require_trial_source_compat "$previous"; then
    echo "automatic rollback refused: $previous would restore implicit trial creation" >&2
    exit 1
  fi
  if ! require_allowance_source_compat "$previous"; then
    echo "automatic rollback refused: $previous is not allowance-source-compatible" >&2
    exit 1
  fi
  if ! require_revocation_compat "$previous"; then
    echo "automatic rollback refused: $previous is not revocation-compatible" >&2
    exit 1
  fi
  # 本函数经 || 调用，errexit 全程被抑制：以下每步失败不会中断脚本，
  # 必须显式中止，避免把 env/current 不一致的中间态推进到 restart。
  restore_env || { echo "rollback failed: env restore failed; aborting" >&2; exit 1; }
  point_to "$previous" || { echo "rollback failed: point_to $previous failed; aborting" >&2; exit 1; }
  sudo -n systemctl restart "$service" || { echo "rollback failed: restart $service failed; aborting" >&2; exit 1; }
  if ! healthy; then
    echo "rollback failed: $previous did not become healthy" >&2
    exit 1
  fi
  echo "restored $previous" >&2
  exit 1
}

rm -rf "$release"
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
rm -f "$archive"
(cd "$release" && bunx pnpm@10.32.1 install --frozen-lockfile --prod --config.confirmModulesPurge=false)

# 试用来源门禁：LCA10 起，进入生产的 origin（含手动 Deploy origin 旧 sha 恢复）
# 必须携带显式创建来源语义；目标缺失即拒绝发布。本门禁纯静态、无副作用，
# 必须先于任何主机状态变更（env 增改/停服/切换）执行——拒绝时
# env/current/服务均未被动过，不存在需要恢复的中间态。
if ! require_trial_source_compat "$release"; then
  exit 1
fi
if ! require_allowance_source_compat "$release"; then
  exit 1
fi

# 环境变量：GitHub production Environment 里的 ORIGIN_ENV_<NAME> secret 写入 server.env 的 <NAME>，只增改这些键；
# 值精确等于 UNSET 时改为从 server.env 删除该键（不写入 KEY=UNSET 行），用于撤销主机上手工预置的键。
mkdir -p "$env_dir" && chmod 700 "$env_dir"
cat "$env_file" > "$env_backup" && chmod 600 "$env_backup"
if [ -n "$env_additions" ] && [ -s "$env_additions" ]; then
  while IFS= read -r line; do
    key=${line%%=*}
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "invalid env key" >&2; restore_env; exit 1; }
    next="$env_dir/server.env.next"
    if [ "${line#*=}" = "UNSET" ]; then
      (umask 077; grep -v "^${key}=" "$env_file" > "$next" || true)
      cat "$next" > "$env_file"
      rm -f "$next"
      echo "env: unset $key"
    else
      (umask 077; { grep -v "^${key}=" "$env_file" || true; printf '%s\n' "$line"; } > "$next")
      cat "$next" > "$env_file"
      rm -f "$next"
      echo "env: set $key"
    fi
  done < "$env_additions"
fi
[ -n "$env_additions" ] && rm -f "$env_additions"

# 撤销兼容门禁：发布（含手动 Deploy origin 旧 sha）若目标不含撤销过滤，
# 仅在 _system 无撤销记录时才放行；判定拒绝时恢复已写入的 env 增改并退出，
# 运行中服务由门禁自身拉回。
if ! require_revocation_compat "$release"; then
  restore_env
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
