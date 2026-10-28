#!/usr/bin/env bash
# 在生产主机上执行的 origin 激活工具：激活在分离的工作进程中完成，状态写入主机状态文件。
# 用法：
#   origin-release.sh --launch <release-id> <archive> <env-additions> <sha> <approval-ref> <deployment-id>
#       登记激活并以 nohup 启动分离工作进程，确认交接后返回。退出码：0 已登记或已存在；
#       75 忙（另一激活持锁）；76 存在已中断的激活（输出 interrupted=<id>，需先 --recover）；
#       2 上传件或参数校验失败（此时未登记、未停服）。
#   origin-release.sh --status <release-id>     只读：状态、阶段、previous、current 与 unit 白名单字段。
#   origin-release.sh --log <release-id>        只读：该激活日志末尾 200 行。
#   origin-release.sh --recover <release-id>    对已中断（工作进程消失且未终态）的激活，分离执行：健康则收敛，否则回滚到登记的 previous。
#   origin-release.sh <release-id> <archive> [env-additions-file]   前台执行（运维与测试用，CI 不使用）。
# 健康失败或工作进程被终止时，恢复登记的 previous release 与 server.env。
set -euo pipefail

root=${ORIGIN_ROOT:-/home/ubuntu/surreal_ck}
service=${ORIGIN_SERVICE:-surreal-ck-hono}
env_file=${ORIGIN_ENV_FILE:-/etc/surreal-ck/server.env}
health_url=${ORIGIN_HEALTH_URL:-http://127.0.0.1:8080/health}
keep=${ORIGIN_KEEP_RELEASES:-8}
staging_dir=${ORIGIN_STAGING_DIR:-/tmp}
export PATH="$HOME/.bun/bin:$PATH"

state_dir="$root/deploy-state"
lock_dir="$state_dir/lock"
env_dir="$root/backups/env"

# 当前激活上下文：由 launch / worker / recover / 前台入口分别填充。
release_id=""
release=""
sha=""
previous=""
archive=""
env_additions=""
approval_ref=""
deployment_id=""
env_backup=""
state_file=""
log_file=""
worker_pid=""
created_at=""
updated_at=""
state=""
note=""
phase=init
settled=0
svc_touched=0
env_dirty=0
switched=0

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

# current_target：输出 current 当前指向的发布目录；current 缺失（不是符号链接）时输出空，即无 previous。
# 不直接用 readlink -f：GNU 对不存在的路径仍返回原路径，BSD 则失败，同一缺失状态会得到不同的 previous。
current_target() {
  if [ -L "$root/current" ]; then
    readlink -f "$root/current" 2>/dev/null || true
  fi
}

# 拒绝/中止路径统一恢复 live env：先写临时文件再 mv 覆盖——若直接
# cat > $env_file，重定向会先于 cat 失败截断目标，把 env 清成空文件。
# 恢复失败显式中止（备份仍在 $env_backup 供人工排查），不静默留下
# 被增改的 env，否则原服务下次重启会读到一次被拒绝发布的配置。
restore_env_command() {
  # 部署用户可能仅拥有 server.env，而父目录仍由 root 管理（0750）。
  # 原子替换需要父目录写权；不放宽目录权限，也不退回截断 live 文件。
  if [ -w "$(dirname "$env_file")" ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

restore_env() {
  local tmp="$env_file.restore.$$"
  # tmp 以默认 umask 创建；env_file 含密钥，恢复后权限收紧到与备份一致。
  if restore_env_command cp -p "$env_backup" "$tmp" \
    && restore_env_command chmod 600 "$tmp" \
    && restore_env_command mv -f "$tmp" "$env_file"; then
    return 0
  fi
  restore_env_command rm -f "$tmp" || true
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
# 输出必须恰好含一行 grant_revocations=<规范非负整数>，其余行为工具噪声予以忽略。
# 子串匹配不可用：grant_revocations=00、同一输出含 0 与 3 两行都必须拒绝。
grant_revocations_present() {
  local server_dir="$1"
  local output matches count rc=0
  output=$(cd "$server_dir" \
    && bun run --env-file="$env_file" src/db/grant-revocation-check-cli.ts 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "revocation gate: check command failed (rc=$rc): $output" >&2
    return 2
  fi
  echo "revocation gate: $output (checker dir: $server_dir)" >&2
  matches=$(printf '%s\n' "$output" | grep -E '^grant_revocations=' || true)
  count=$(printf '%s' "$matches" | grep -c . || true)
  if [ "$count" != 1 ]; then
    echo "revocation gate: checker output must contain exactly one grant_revocations line; cannot prove safety" >&2
    return 2
  fi
  if [[ "$matches" =~ ^grant_revocations=0$ ]]; then
    return 0
  fi
  if [[ "$matches" =~ ^grant_revocations=[1-9][0-9]*$ ]]; then
    return 1
  fi
  echo "revocation gate: grant_revocations value is not a canonical count; cannot prove safety" >&2
  return 2
}

# 门禁拒绝后的服务处置。restore（前向激活：被冻结的是原 current）拉回原服务，即使带病也好过授权语义回退；
# 拉起前必须先恢复 server.env：服务只能以激活前的配置启动，不得以已被拒绝的增改启动。
# restore_env 失败时直接退出，服务保持停止（ensure_service_running 在 env 未恢复时不拉起）。
# hold（回滚：被拒的是 previous）不拉起被拒目标，保持冻结态并留痕，由运维决定（见 runbook）。
revival_after_refusal() {
  if [ "${1:-restore}" = hold ]; then
    echo "revocation gate: $service is left stopped (rollback target refused; not restarted by rollback)" >&2
    return 0
  fi
  if [ "$env_dirty" = 1 ]; then
    phase=env-restore
    restore_env
    env_dirty=0
  fi
  sudo -n systemctl start "$service" || echo "revocation gate: WARN failed to restore $service" >&2
}

# 第二参数 policy：restore（默认，前向激活，拉回被冻结的原 current）或 hold（回滚，被拒的是 previous，
# 门禁拒绝后不拉起它）。拒绝时的服务处置统一由 revival_after_refusal 决定。
require_revocation_compat() {
  local target="$1" policy="${2:-restore}"
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
      revival_after_refusal "$policy"
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
    revival_after_refusal "$policy"
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

is_terminal() {
  case "$1" in
    healthy|refused|failed|rolled-back|rollback-refused|rollback-failed) return 0 ;;
    *) return 1 ;;
  esac
}

# 原子替换状态文件。只写状态、阶段、路径、批准号、进程号、时间与阶段标记，不写 env 值。
write_state() {
  state=$1
  note=${2:-}
  note=${note//$'\n'/ }
  updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "state: $state phase=$phase $note" >&2
  [ -n "$state_file" ] || return 0
  local tmp="$state_file.tmp.$$"
  {
    echo "state=$state"
    echo "release_id=$release_id"
    echo "sha=$sha"
    echo "phase=$phase"
    echo "previous=$previous"
    echo "archive=$archive"
    echo "env_additions=$env_additions"
    echo "approval_ref=$approval_ref"
    echo "deployment_id=$deployment_id"
    echo "worker_pid=$worker_pid"
    echo "env_dirty=$env_dirty"
    echo "svc_touched=$svc_touched"
    echo "switched=$switched"
    echo "created_at=$created_at"
    echo "updated_at=$updated_at"
    echo "log=$log_file"
    echo "note=$note"
  } > "$tmp"
  mv -f "$tmp" "$state_file"
}

# 进入新阶段：标记先落盘，再执行可能中断的动作。
set_phase() {
  phase=$1
  write_state running "${2:-}"
}

# 加载某次激活的上下文；状态文件不存在返回 1。只读。
load_state() {
  local k v
  state_file="$state_dir/$1.state"
  [ -f "$state_file" ] || return 1
  release_id=$1
  state=""
  sha=""
  phase=""
  previous=""
  archive=""
  env_additions=""
  approval_ref=""
  deployment_id=""
  worker_pid=""
  env_dirty=0
  svc_touched=0
  switched=0
  created_at=""
  updated_at=""
  log_file=""
  note=""
  while IFS='=' read -r k v; do
    case "$k" in
      state) state=$v ;;
      sha) sha=$v ;;
      phase) phase=$v ;;
      previous) previous=$v ;;
      archive) archive=$v ;;
      env_additions) env_additions=$v ;;
      approval_ref) approval_ref=$v ;;
      deployment_id) deployment_id=$v ;;
      worker_pid) worker_pid=$v ;;
      env_dirty) env_dirty=$v ;;
      svc_touched) svc_touched=$v ;;
      switched) switched=$v ;;
      created_at) created_at=$v ;;
      updated_at) updated_at=$v ;;
      log) log_file=$v ;;
      note) note=$v ;;
    esac
  done < "$state_file"
  release="$root/releases/$release_id"
  env_backup="$env_dir/server.env.$release_id"
}

# 读取其它激活的单个字段（只读，不改变当前上下文）。
read_field() {
  local f="$state_dir/$1.state" v
  [ -f "$f" ] || return 0
  v=$(grep -m1 "^$2=" "$f" || true)
  printf '%s' "${v#*=}"
}

# 活跃性以锁为准：锁属于本激活且持有者进程存活。
worker_alive() {
  local owner rel
  owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  rel=$(cat "$lock_dir/release" 2>/dev/null || true)
  [ -n "$owner" ] && [ "$rel" = "$release_id" ] && kill -0 "$owner" 2>/dev/null
}

# 对外状态：终态原样；非终态且工作进程存活时保持 running；否则为 interrupted（工作进程已消失）。
derived_state() {
  if is_terminal "$state" || worker_alive; then
    printf '%s' "$state"
  else
    printf '%s' interrupted
  fi
}

# 只读 unit 白名单字段（不读 journal，不回显 env）。
print_unit() {
  systemctl show -p ActiveState -p SubState -p MainPID -p ExecMainStatus -p Result -p NRestarts "$service" 2>/dev/null \
    | grep -E '^(ActiveState|SubState|MainPID|ExecMainStatus|Result|NRestarts)=' || echo "unit=unavailable"
}

print_status() {
  echo "state=$(derived_state)"
  echo "release_id=$release_id"
  echo "sha=$sha"
  echo "phase=$phase"
  echo "previous=$previous"
  echo "current=$(readlink "$root/current" 2>/dev/null || echo none)"
  echo "approval_ref=$approval_ref"
  echo "deployment_id=$deployment_id"
  echo "worker_pid=$worker_pid"
  echo "updated_at=$updated_at"
  echo "log=$log_file"
  echo "note=$note"
  print_unit
}

set_lock_owner() {
  printf '%s\n' "$1" > "$lock_dir/pid"
}

release_lock() {
  local owner
  owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [ "$owner" = "$$" ]; then
    rm -rf "$lock_dir"
  fi
}

# 交接：锁仍属于本激活时，把持有者换成工作进程 pid（launch 与工作进程写同一个值，先到先写均可）。
adopt_worker_pid() {
  local rel
  rel=$(cat "$lock_dir/release" 2>/dev/null || true)
  if [ "$rel" = "$release_id" ]; then
    set_lock_owner "$1" 2>/dev/null || true
  fi
}

# acquire_lock <release-id> <owner-pid> [reclaim-id]：mkdir 互斥。
# 锁被存活进程持有 → 75；持有者已死且其激活未终态（且不是 reclaim-id）→ 76 并输出 interrupted=<id>；
# 其余为陈旧锁：先取得回收互斥 lock.reclaim（mkdir 原子，同一时刻只有一个回收者），在互斥内重新核验锁，
# 再把陈旧锁原子重命名到隔离名后删除副本并重建。回收互斥的持有者已死（回收中途被终止）时不自动删除，
# 返回 75 并要求运维核查；不存在自动豁免。
acquire_lock() {
  local owner other other_state reclaim="$state_dir/lock.reclaim" quarantine="$state_dir/lock.stale.$$"
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$1" > "$lock_dir/release"
    set_lock_owner "$2"
    return 0
  fi
  if ! mkdir "$reclaim" 2>/dev/null; then
    local rpid
    rpid=$(cat "$reclaim/pid" 2>/dev/null || true)
    if [ -n "$rpid" ] && kill -0 "$rpid" 2>/dev/null; then
      echo "busy: stale-lock reclaim is in progress (pid $rpid)" >&2
    elif [ -z "$rpid" ] && [ -z "$(find "$reclaim" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      echo "busy: stale-lock reclaim is being claimed" >&2
    else
      echo "busy: stale-lock reclaim mutex $reclaim is held by pid ${rpid:-unknown}, which is gone; needs operator review (not removed)" >&2
    fi
    return 75
  fi
  printf '%s\n' "$$" > "$reclaim/pid"
  # 互斥内重新核验：锁可能已被释放（此时直接取得）或已被他人重建。
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$1" > "$lock_dir/release"
    set_lock_owner "$2"
    release_reclaim
    return 0
  fi
  owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  other=$(cat "$lock_dir/release" 2>/dev/null || true)
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    echo "busy: activation ${other:-unknown} is running (pid $owner)" >&2
    release_reclaim
    return 75
  fi
  if [ -z "$owner" ] && [ -z "$(find "$lock_dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    echo "busy: activation lock is being claimed" >&2
    release_reclaim
    return 75
  fi
  if [ -n "$other" ] && [ "$other" != "${3:-}" ]; then
    other_state=$(read_field "$other" state)
    if [ -n "$other_state" ] && ! is_terminal "$other_state"; then
      echo "interrupted=$other"
      echo "activation $other was interrupted (worker gone); run --recover $other first" >&2
      release_reclaim
      return 76
    fi
  fi
  # 原子移出陈旧锁（重命名）后删除移出的副本：删除的对象不再占用活动锁路径。
  if mv "$lock_dir" "$quarantine" 2>/dev/null; then
    rm -rf "$quarantine"
  fi
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$1" > "$lock_dir/release"
    set_lock_owner "$2"
    release_reclaim
    return 0
  fi
  echo "busy: lock was claimed concurrently" >&2
  release_reclaim
  return 75
}

# 回收互斥只由其持有者（pid 为本进程）释放；其余情况保持原样。
release_reclaim() {
  if [ "$(cat "$state_dir/lock.reclaim/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf "$state_dir/lock.reclaim"
  fi
}

probe_once() {
  local body
  body=$(curl -fsS --max-time 5 "$health_url" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q '"status":"ok","surrealdb":"up"'
}

cleanup_old_releases() {
  # 只清理 CI 生成的旧发布与 env 备份，保留最近 $keep 个；手工发布目录不动。清理失败不影响已健康的结果。
  ls -1dt "$root"/releases/*-ci* 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
    [ "$(readlink -f "$root/current")" = "$old" ] || rm -rf "$old"
  done || true
  ls -1t "$env_dir"/server.env.*-ci* 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f || true
}

# settle <terminal-state> <message>：记录终态、释放锁、删除暂存的归档与 env 文件（含密钥）。
# 终态之后不再有主机状态变更。
settle() {
  settled=1
  echo "$2" >&2
  write_state "$1" "$2"
  release_lock
  if [ -n "$archive" ]; then rm -f "$archive"; fi
  if [ -n "$env_additions" ]; then rm -f "$env_additions"; fi
}

# 主机是否已被本激活改动（服务被停/切换过，或 env 已写入）。
host_changed() {
  [ "$svc_touched" = 1 ] || [ "$switched" = 1 ] || [ "$env_dirty" = 1 ]
}

service_active() {
  [ "$(systemctl is-active "$service" 2>/dev/null || true)" = active ]
}

# 不让本激活的冻结（停服）留下长期停止的服务。env 仍含本激活的增改（env_dirty=1，恢复未完成）时绝不拉起：
# 服务不得以未恢复、可能已被拒绝的配置启动，保持停止态并由终态要求人工核查。
ensure_service_running() {
  if [ "$env_dirty" = 1 ]; then
    echo "service not started: server.env still carries this activation's additions" >&2
    return 0
  fi
  if [ "$svc_touched" = 1 ] && ! service_active; then
    sudo -n systemctl start "$service" >/dev/null 2>&1 || true
  fi
}

# refuse_with_env_restore <reason>：门禁或 env 校验拒绝。env 已写入则先恢复备份；门禁拒绝时已在拉起服务前恢复 env
# 并拉回原服务（见 revival_after_refusal）。若服务仍不活跃则不能报告为 refused，以 failed 结束并要求人工核查。
refuse_with_env_restore() {
  if [ "$env_dirty" = 1 ]; then
    phase=env-restore
    restore_env
    env_dirty=0
  fi
  if [ "$svc_touched" = 1 ] && ! service_active; then
    settle failed "$1; $service is not active after the refusal; host needs a manual check"
    exit 1
  fi
  svc_touched=0
  settle refused "$1"
  exit 1
}

# abort_forward <reason>：转发路径失败。服务被停或已切换则回滚到登记的 previous；
# 否则只恢复已写入的 env，并以 failed 结束（主机未改动服务）。
abort_forward() {
  if [ "$svc_touched" = 1 ] || [ "$switched" = 1 ]; then
    rollback "$1"
  fi
  if [ "$env_dirty" = 1 ]; then
    phase=env-restore
    restore_env
    env_dirty=0
  fi
  settle failed "$1; no service change"
  exit 1
}

# rollback_refuse <reason>：自动回滚被门禁拒绝。回滚尚未切换 current，先恢复已写入的 env。
# 服务仍活跃 → rollback-refused（运行中的版本未变）；服务已被冻结停止 → rollback-failed，
# 回滚不拉起被拒目标，需人工决定（见 runbook「回滚被拒」）。
rollback_refuse() {
  if [ "$env_dirty" = 1 ]; then
    phase=env-restore-rollback
    restore_env
    env_dirty=0
  fi
  if [ "$svc_touched" = 1 ] && ! service_active; then
    settle rollback-failed "$1; $service is not active and was not restarted by rollback; host needs a manual decision"
  else
    svc_touched=0
    settle rollback-refused "$1"
  fi
  exit 1
}

# rollback <reason>：恢复登记的 previous（env 备份、current、服务）。总是以 exit 1 结束。
# 门禁先于任何状态变更执行：试用与分配来源门禁拒绝时 env/current/服务均未被触碰；
# 撤销门禁拒绝时门禁已自行拉回服务。
rollback() {
  phase=rollback
  write_state running "rolling back to ${previous:-none}: $1"
  echo "release $release_id failed: $1; restoring ${previous:-none}" >&2
  # 服务未停、current 未切换（只有 env 增改已写入，例如 env-write 阶段被中断）：运行中的版本没有变化。
  # 只恢复 env，不做撤销冻结、不重启，也不因 previous 缺失或门禁拒绝而留下未切换却已改 env 的主机。
  if [ "$svc_touched" = 0 ] && [ "$switched" = 0 ]; then
    if [ "$env_dirty" = 1 ]; then
      phase=env-restore-rollback
      restore_env
      env_dirty=0
    fi
    settle failed "$1; no service change, env restored"
    exit 1
  fi
  if [ -z "$previous" ]; then
    rollback_refuse "automatic rollback refused: no previous release was recorded"
  fi
  if ! require_trial_source_compat "$previous"; then
    rollback_refuse "automatic rollback refused: $previous would restore implicit trial creation"
  fi
  if ! require_allowance_source_compat "$previous"; then
    rollback_refuse "automatic rollback refused: $previous is not allowance-source-compatible"
  fi
  svc_touched=1
  if ! require_revocation_compat "$previous" hold; then
    rollback_refuse "automatic rollback refused: $previous is not revocation-compatible"
  fi
  if [ "$env_dirty" = 1 ]; then
    phase=env-restore-rollback
    restore_env
    env_dirty=0
  fi
  phase=rollback-switch
  if ! point_to "$previous"; then
    settle rollback-failed "rollback failed: point_to $previous failed; aborting"
    exit 1
  fi
  if ! sudo -n systemctl restart "$service"; then
    settle rollback-failed "rollback failed: restart $service failed; aborting"
    exit 1
  fi
  phase=rollback-health
  if ! healthy; then
    settle rollback-failed "rollback failed: $previous did not become healthy"
    exit 1
  fi
  settle rolled-back "restored $previous"
  exit 1
}

# abort_unsettled <why>：工作进程在终态前异常结束（未预期失败或信号）。
abort_unsettled() {
  case "$phase" in
    env-restore)
      # 前向路径（门禁拒绝或中止后的 env 恢复）：恢复未完成则服务保持停止，以 failed 结束要求人工核查。
      ensure_service_running
      if [ "$env_dirty" = 1 ]; then
        settle failed "$1; env restore did not complete; $service left stopped; backup kept at $env_backup"
      else
        settle failed "$1; env restored"
      fi
      ;;
    env-restore-rollback)
      ensure_service_running
      if [ "$env_dirty" = 1 ]; then
        settle rollback-failed "$1; env restore did not complete; $service left stopped; backup kept at $env_backup"
      else
        settle rollback-failed "$1; env restored; rollback did not complete"
      fi
      ;;
    rollback*)
      ensure_service_running
      settle rollback-failed "$1; rollback did not complete in phase $phase"
      ;;
    *)
      if host_changed; then
        rollback "$1"
      fi
      settle failed "$1; no host change"
      ;;
  esac
  exit 1
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$settled" = 0 ]; then
    abort_unsettled "exited with status $rc in phase $phase"
  fi
  exit "$rc"
}

on_signal() {
  trap - EXIT
  if [ "$settled" = 0 ]; then
    abort_unsettled "received SIG$1 in phase $phase"
  fi
  exit 1
}

install_traps() {
  trap on_exit EXIT
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
}

# 逐行应用 env 增改：值精确为 UNSET 则删除该键；键名非法则恢复备份并拒绝。
apply_env_additions() {
  local line key next
  if [ -z "$env_additions" ]; then
    return 0
  fi
  # 登记时已确认存在；执行前若丢失，不能当作「无增改」静默继续。
  if [ ! -f "$env_additions" ]; then
    refuse_with_env_restore "env additions file is missing"
  fi
  if [ ! -s "$env_additions" ]; then
    return 0
  fi
  while IFS= read -r line; do
    key=${line%%=*}
    if ! [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      refuse_with_env_restore "invalid env key"
    fi
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
}

# rollback_preflight：转发激活在依赖安装之前核验登记的 previous 可被回滚（存在，且通过试用与分配来源门禁）。
# 纯静态检查：零服务变更、零 env 写入；任一不成立即以 refused 结束。
rollback_preflight() {
  if [ -z "$previous" ]; then
    settle refused "rollback preflight refused: no previous release recorded"
    exit 1
  fi
  if [ ! -d "$previous" ]; then
    settle refused "rollback preflight refused: previous release $previous is missing"
    exit 1
  fi
  if ! require_trial_source_compat "$previous"; then
    settle refused "rollback preflight refused: $previous would restore implicit trial creation"
    exit 1
  fi
  if ! require_allowance_source_compat "$previous"; then
    settle refused "rollback preflight refused: $previous is not allowance-source-compatible"
    exit 1
  fi
}

# rollback_revocation_precheck：previous 不含撤销过滤时，停服前的撤销计数非零或无法证明即拒绝。
# 检查器导入依赖包（surrealdb），因此在依赖安装之后、停服与 env 写入之前，于新发布目录中执行。
# 计数为零只表示允许继续，停服冻结之后的撤销复核仍然必需（排空窗口内的 in-flight 写入）。
rollback_revocation_precheck() {
  local server_dir="" verdict=0
  if target_has_revocation_filter "$previous"; then
    return 0
  fi
  if server_dir=$(find_revocation_checker_dir); then
    grant_revocations_present "$server_dir" || verdict=$?
  else
    verdict=2
  fi
  if [ "$verdict" -ne 0 ]; then
    settle refused "rollback preflight refused: previous $previous lacks revocation filtering and grant revocations are present or unprovable"
    exit 1
  fi
}

# run_release：转发激活主流程，工作进程与前台入口共用。停服、切换、env 写入之前，
# 上传校验、解包、依赖安装与静态门禁已全部完成；每个可能中断的动作前标记已先落盘。
run_release() {
  set_phase unpack "unpacking staged archive"
  rm -rf "$release"
  mkdir -p "$release"
  if ! tar -xzf "$archive" -C "$release"; then
    abort_forward "archive unpack failed"
  fi
  rm -f "$archive"

  # 回滚前提预检：依赖安装、env 写入、停服之前核验登记的 previous 可被回滚。
  set_phase preflight "rollback preconditions for ${previous:-none}"
  rollback_preflight

  set_phase install "installing production dependencies"
  if ! (cd "$release" && bunx pnpm@10.32.1 install --frozen-lockfile --prod --config.confirmModulesPurge=false); then
    abort_forward "dependency install failed"
  fi

  # 撤销预检：安装之后、任何 env 写入与停服之前执行（检查器需要新发布的依赖）。
  set_phase preflight "revocation precheck for previous ${previous:-none}"
  rollback_revocation_precheck

  # 试用与分配来源门禁：纯静态、无副作用，先于 env 与服务的任何变更执行。
  set_phase gate "static trial and allowance source gates"
  if ! require_trial_source_compat "$release"; then
    settle refused "trial source gate refused $release"
    exit 1
  fi
  if ! require_allowance_source_compat "$release"; then
    settle refused "allowance source gate refused $release"
    exit 1
  fi

  # 环境变量：先备份，再逐行增改；env_dirty 在第一次写入前置位。
  set_phase env-backup "backing up server.env"
  mkdir -p "$env_dir"
  chmod 700 "$env_dir"
  if ! { cat "$env_file" > "$env_backup" && chmod 600 "$env_backup"; }; then
    abort_forward "server.env backup failed"
  fi
  env_dirty=1
  set_phase env-write "applying server.env additions"
  apply_env_additions
  if [ -n "$env_additions" ]; then rm -f "$env_additions"; fi

  # 撤销兼容门禁：可能停服冻结写入；拒绝时门禁已拉回服务，这里恢复 env 并以 refused 结束。
  svc_touched=1
  set_phase revocation "revocation compatibility gate for $release"
  if ! require_revocation_compat "$release"; then
    refuse_with_env_restore "revocation gate refused $release"
  fi

  # 发布钩子：只有通过全部门禁与 env 写入之后才停服执行。
  hook="$release/scripts/deploy/origin-pre-start.sh"
  if [ -f "$hook" ]; then
    svc_touched=1
    set_phase hook "stopping $service for pre-start hook"
    echo "stopping $service for pre-start hook"
    if ! sudo -n systemctl stop "$service"; then
      abort_forward "stop before pre-start hook failed"
    fi
    if ! (cd "$release" && ORIGIN_ENV_FILE="$env_file" bash "$hook"); then
      abort_forward "pre-start hook failed"
    fi
  fi

  switched=1
  svc_touched=1
  set_phase switch "switching ${previous:-none} -> $release"
  echo "switching ${previous:-none} -> $release"
  if ! point_to "$release"; then
    abort_forward "switching current to $release failed"
  fi
  if ! sudo -n systemctl restart "$service"; then
    abort_forward "restart $service failed"
  fi
  set_phase health "probing health after restart"
  if ! healthy; then
    abort_forward "health check failed"
  fi
  set_phase verified "release $release_id is healthy"
  echo "release $release_id healthy"
  cleanup_old_releases
  settle healthy "release $release_id healthy"
  exit 0
}

# recover_flow：--recover 后的工作进程。已验证健康且 current 指向本发布则直接收敛为 healthy，
# 未改动主机则 failed，其余回滚到登记的 previous。
recover_flow() {
  if ! host_changed; then
    settle failed "recovered: interrupted before any host change; nothing rolled back"
    exit 0
  fi
  if [ "$phase" = verified ] \
    && [ "$(readlink -f "$root/current" 2>/dev/null || true)" = "$(readlink -f "$release" 2>/dev/null || true)" ] \
    && probe_once; then
    settle healthy "recovered: $release_id was verified healthy before the interruption"
    exit 0
  fi
  rollback "recovery after interruption in phase $phase"
}

# ---------------------------------------------------------------------------
# 入口校验：任何失败都在登记、锁、停服之前以 exit 2 返回。env 值从不输出。
# ---------------------------------------------------------------------------
reject() {
  echo "rejected: $*" >&2
  exit 2
}

check_release_id() {
  if ! [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [ "${#1}" -gt 128 ]; then
    reject "release id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (max 128)"
  fi
}

# env 增改文件的每一行都必须是 KEY=VALUE（KEY 为大写 ENV 名）。返回 0 表示存在坏行或无法判定。
env_lines_invalid() {
  local rc=0
  [ -s "$1" ] || return 1
  grep -Eqv '^[A-Z][A-Z0-9_]*=' "$1" || rc=$?
  if [ "$rc" -eq 1 ]; then
    return 1
  fi
  return 0
}

launch_main() {
  local id=${1:-} archive_in=${2:-} env_in=${3:-} sha_in=${4:-} approval_in=${5:-} deploy_in=${6:-}
  [ "$#" -eq 6 ] || reject "usage: --launch <release-id> <archive> <env-additions> <sha> <approval-ref> <deployment-id>"
  check_release_id "$id"
  [[ "$sha_in" =~ ^[0-9a-f]{40}$ ]] || reject "sha must be a full lowercase commit SHA"
  [[ "$approval_in" =~ ^[A-Za-z0-9._:/#-]{4,120}$ ]] || reject "approval-ref is missing or malformed"
  [[ "$deploy_in" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || reject "deployment-id is missing or malformed"
  [ "$archive_in" = "$staging_dir/surreal_ck-$id.tar.gz" ] || reject "archive is not the staged path for $id"
  [ "$env_in" = "$staging_dir/surreal_ck-env-$id" ] || reject "env additions is not the staged path for $id"

  # 已登记的激活（含 CI 重试）先于上传件校验判定：工作进程结束时会删除暂存件，
  # 重试必须报告既有结果，而不是因暂存件已被清理而拒绝。
  if [ -f "$state_dir/$id.state" ]; then
    load_state "$id"
    if [ "$sha" != "$sha_in" ] || [ "$approval_ref" != "$approval_in" ]; then
      reject "release $id is already registered with different parameters"
    fi
    if is_terminal "$state"; then
      # 终态重试：工作进程已结束并清理过暂存件，本次上传的副本无人使用，删除之（含密钥）。
      rm -f "$archive_in" "$env_in"
      echo "registered=$id state=$state"
      exit 0
    fi
    if worker_alive; then
      echo "registered=$id state=running"
      exit 0
    fi
    echo "interrupted=$id"
    echo "activation $id was interrupted (worker gone); run --recover $id" >&2
    exit 76
  fi

  # 新登记：上传件与 env 增改在取锁、登记、停服之前全部校验。
  if ! [ -f "$archive_in" ] || [ -L "$archive_in" ]; then reject "staged archive is missing"; fi
  if ! [ -f "$env_in" ] || [ -L "$env_in" ]; then reject "staged env additions file is missing"; fi
  tar -tzf "$archive_in" >/dev/null 2>&1 || reject "staged archive is not a readable tar.gz"
  if env_lines_invalid "$env_in"; then reject "env additions contain a malformed line (values are not printed)"; fi

  acquire_lock "$id" "$$" || exit $?
  release_id=$id
  sha=$sha_in
  approval_ref=$approval_in
  deployment_id=$deploy_in
  archive=$archive_in
  env_additions=$env_in
  previous=$(current_target)
  created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  release="$root/releases/$id"
  env_backup="$env_dir/server.env.$id"
  state_file="$state_dir/$id.state"
  log_file="$state_dir/$id.log"
  worker_pid=""
  env_dirty=0
  svc_touched=0
  switched=0
  settled=0
  phase=registered
  write_state running "registered by launch; detached worker starting"
  # 日志可能含工具输出，限制为本用户可读。
  : >> "$log_file"
  chmod 600 "$log_file"
  # 工作进程脱离 ssh 会话：stdio 全部指向日志文件，断线不会产生 SIGPIPE，nohup 忽略 SIGHUP。
  nohup bash "$0" --worker "$id" launch "$$" </dev/null >>"$log_file" 2>&1 &
  adopt_worker_pid "$!"
  echo "registered=$id state=running"
  exit 0
}

status_main() {
  check_release_id "${1:-}"
  if [ ! -f "$state_dir/$1.state" ]; then
    echo "state=absent"
    echo "release_id=$1"
    exit 0
  fi
  load_state "$1"
  print_status
  exit 0
}

# 只读：输出该激活日志的末尾 200 行（日志只含阶段记录与工具输出，env 值不写入）。
log_main() {
  check_release_id "${1:-}"
  [ -f "$state_dir/$1.state" ] || reject "no activation registered for $1"
  load_state "$1"
  echo "log=$log_file"
  if [ -f "$log_file" ]; then
    tail -n 200 "$log_file"
  fi
  exit 0
}

recover_main() {
  check_release_id "${1:-}"
  local id=$1
  [ -f "$state_dir/$id.state" ] || reject "no activation registered for $id"
  load_state "$id"
  if is_terminal "$state"; then
    reject "nothing to recover: $id is $state"
  fi
  if worker_alive; then
    echo "busy: $id is still running" >&2
    exit 75
  fi
  acquire_lock "$id" "$$" "$id" || exit $?
  worker_pid=""
  write_state running "recovery requested after interruption"
  nohup bash "$0" --worker "$id" recover "$$" </dev/null >>"$log_file" 2>&1 &
  adopt_worker_pid "$!"
  echo "recovery-started=$id"
  exit 0
}

# 工作进程入口（仅由 --launch/--recover 以 nohup 启动）。锁必须仍属于本激活；
# 锁持有者若是另一个存活进程则拒绝接管。
worker_main() {
  local id=${1:-} mode=${2:-launch} launcher=${3:-} owner rel
  check_release_id "$id"
  load_state "$id" || exit 1
  if is_terminal "$state"; then
    exit 0
  fi
  owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  rel=$(cat "$lock_dir/release" 2>/dev/null || true)
  if [ "$rel" != "$id" ]; then
    echo "worker: lock is not held for $id; not starting" >&2
    exit 1
  fi
  if [ -n "$owner" ] && [ "$owner" != "$$" ] && [ "$owner" != "$launcher" ] && kill -0 "$owner" 2>/dev/null; then
    echo "worker: another activation owns the lock (pid $owner); not starting" >&2
    exit 75
  fi
  set_lock_owner "$$"
  worker_pid=$$
  write_state running "worker started ($mode)"
  install_traps
  if [ "$mode" = recover ]; then
    recover_flow
  else
    run_release
  fi
  exit 0
}

# 前台执行（运维与测试用，CI 不使用）：与工作进程共用同一条激活流程，结果同样写入状态文件。
foreground_main() {
  local id=${1:-} archive_in=${2:-} env_in=${3:-}
  check_release_id "$id"
  [ -n "$archive_in" ] || reject "usage: <release-id> <archive> [env-additions-file]"
  [ -f "$archive_in" ] || reject "archive not found: $archive_in"
  if [ -f "$state_dir/$id.state" ]; then
    reject "release $id is already registered"
  fi
  acquire_lock "$id" "$$" || exit $?
  release_id=$id
  sha=""
  approval_ref="foreground"
  deployment_id="foreground"
  archive=$archive_in
  env_additions=$env_in
  previous=$(current_target)
  created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  release="$root/releases/$id"
  env_backup="$env_dir/server.env.$id"
  state_file="$state_dir/$id.state"
  log_file="(foreground)"
  worker_pid=$$
  env_dirty=0
  svc_touched=0
  switched=0
  settled=0
  phase=registered
  write_state running "foreground activation"
  install_traps
  run_release
}

usage() {
  cat <<'EOF'
用法：
  origin-release.sh --launch <release-id> <archive> <env-additions> <sha> <approval-ref> <deployment-id>
  origin-release.sh --status <release-id>
  origin-release.sh --log <release-id>
  origin-release.sh --recover <release-id>
  origin-release.sh <release-id> <archive> [env-additions-file]
EOF
}

case "${1:-}" in
  --launch) shift; launch_main "$@" ;;
  --status) shift; status_main "${1:-}" ;;
  --log) shift; log_main "${1:-}" ;;
  --recover) shift; recover_main "${1:-}" ;;
  --worker) shift; worker_main "$@" ;;
  -h|--help) usage ;;
  "") usage >&2; exit 2 ;;
  *) foreground_main "$@" ;;
esac
