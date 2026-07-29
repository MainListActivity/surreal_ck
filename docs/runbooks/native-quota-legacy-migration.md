# 原生配额旧事件迁移运行手册

本手册只用于从 workspace 内 `resource_quota_guard` 事件迁移到
`native-quota-v1`。日常套餐、override 和 ledger 维护继续走运营意图，
不得调用本 conductor。

## 不可突破的门

- 旧 `resource_quota_plan`、`workspace_resource_quota` 和
  `sheet_resource_usage` 只进入 inventory 的 discrepancy evidence，永不写入
  subscription、entitlement 或 native ledger。
- 每个 active workspace 必须恰有一条运营批准 assignment；unknown、
  duplicate、workspace/slug/db mismatch、计划或付款账户缺失都会在任何商业
  权威写入前终止。
- 只有 `prepare` 或 `assert-reopen` 输出
  `public_reopen_gate_passed` 后，部署编排器才可以重新开放公网 WSS/HTTP。
- 去旧 transaction 前后 native policy 都存在；提交未知必须 INFO/event
  readback，禁止盲目重放。
- blocking signal 会原子地把 run/cohort 置为 paused；不得通过手改 `_system`
  绕过。
- cleanup 需要全部 active workspace `native_verified`、全量 audit clean、
  pre-native 应用已被 compatibility gate 淘汰，以及至少 30 日稳定窗。

## 1. 盘点前

1. 冻结旧 `assign-plan.surql`、`update-plus.surql` 和非审计套餐修改。
2. 保持普通业务写入，生成 draft assignment JSON。数组中每项必须显式指定：

```json
{
  "workspace_id": "workspace:acme",
  "workspace_slug": "acme",
  "database": "ws_acme",
  "billing_account_id": "billing_account:acme",
  "plan_revision_id": "quota_plan_revision:plus_v1",
  "source": "manual",
  "effective_at": "2026-07-29T00:00:00.000Z",
  "rollout_class": "standard",
  "evidence_reference": "contract-or-support-ticket"
}
```

3. 运行 dry-run inventory：

```sh
pnpm quota:migration inventory \
  --run nq-cutover-2026-07 \
  --draft ./assignments.draft.json \
  --out ./inventory.json
```

`--out` 使用 create-only 写入，已存在文件不会覆盖。核对 workspace/db 映射、
旧三档值和 counters、真实 table/field/record、event target、目标 policy、
overage 与 anomalies。所有 `severity=blocker` 必须清零；旧 counter discrepancy
只解释差异，不能用 override 自动“修平”。

## 2. 批准 assignment manifest

批准文件顶层格式：

```json
{
  "format_version": 1,
  "manifest_id": "nq-cutover-2026-07-approved-1",
  "inventory_checksum": "sha256:...",
  "approved_by_subject": "operator-subject",
  "approved_at": "2026-07-29T00:00:00.000Z",
  "assignments": [],
  "checksum": "sha256:..."
}
```

批准 actor 必须是 active platform operator，并持有 `subscription.manage`。
先移除或留空顶层 `checksum`，计算 canonical checksum 后再写回：

```sh
pnpm quota:migration checksum --file ./manifest.unsigned.json
pnpm quota:migration import \
  --run nq-cutover-2026-07 \
  --manifest ./manifest.approved.json
```

import 会先验证完整集合，再以确定性记录建立 manual/contract
subscription/item，并调用同一 resolver/compiler 生成 entitlement/projection。
重跑同一 checksum 幂等；不同内容复用 run/manifest identity 会失败。

## 3. 全局维护窗与安全启用

1. 停止公网 WSS/HTTP 写入口并排空连接。
2. 创建完整 datastore snapshot，完成 restore drill。
3. 用匹配 CLI 完成 fork format migration；以同一签名 image digest 和已认证
   backend 启动内网节点。
4. 保存 maintenance evidence：

```json
{
  "snapshot_id": "snapshot-...",
  "snapshot_checksum": "sha256:...",
  "restore_drill_completed_at": "2026-07-29T01:00:00.000Z",
  "fork_release": "surreal-ck-quota-v1",
  "fork_image_digest": "sha256:...",
  "compatibility_manifest_revision": "native-quota-v1",
  "backend": "rocksdb",
  "backend_certification_revision": "native-quota-rocksdb-v1",
  "format_migration_completed_at": "2026-07-29T01:30:00.000Z"
}
```

5. 执行：

```sh
pnpm quota:migration prepare \
  --run nq-cutover-2026-07 \
  --evidence ./maintenance-evidence.json
```

顺序固定为 `_system`、全部 active workspace：`REBUILD QUOTA IF NEEDED` →
独立 catalog/record scan → 完全一致校验 → desired policy 物化 → fresh INFO/scan
readback → `native_policy_active`。任一缺口都会非零退出且 WSS 继续关闭。

重新开放前可再次执行：

```sh
pnpm quota:migration assert-reopen --run nq-cutover-2026-07
```

只有输出 `public_reopen_gate_passed` 才可开放。此时旧 events 仍保留，所有
workspace 已有 native enforcement，不存在只靠 legacy event 的窗口。

## 4. 分 cohort 原子去旧

固定顺序：

1. `synthetic_internal`（至少观察 24h）
2. `one_percent`（至少观察 24h，standard workspace 最少一个）
3. `ten_percent`（至少观察 48h）
4. `fifty_percent`（至少观察 48h）
5. `remainder`

```sh
pnpm quota:migration cutover \
  --run nq-cutover-2026-07 \
  --cohort synthetic_internal

pnpm quota:migration complete-cohort \
  --run nq-cutover-2026-07 \
  --cohort synthetic_internal
```

cutover 对每个 workspace 取得 lease/fencing token，做 fresh INFO、impact 和独立
scan，然后在目标 database 的同一 transaction 中：

1. `DEFINE QUOTA OVERWRITE ... EXPECT GENERATION ...` 重新断言同一完整策略；
2. 删除 `sheet` 和 inventory 中全部动态 `ent_*` 的
   `resource_quota_guard`；
3. commit 后再次 INFO/scan/event readback，才标记 `native_verified`。

提交未知时，events 全部存在表示未提交，可安全重试；全部不存在且
policy/usage 一致表示已提交；半切或未知 drift 会自动暂停。

## 5. 信号、暂停、恢复与终止

故障探针可写入：

```sh
pnpm quota:migration signal \
  --run nq-cutover-2026-07 \
  --cohort ten_percent \
  --signal ./signal.json
```

`false_negative`、`counter_mismatch`、`ledger_corrupt`、
`structured_error_lost`、`unknown_drift`、`cross_workspace_leak` 和
`recovery_failed` 都是 blocking。修复并完成 fresh readback 后：

```sh
pnpm quota:migration resume --run nq-cutover-2026-07
```

人工暂停与不可恢复终止：

```sh
pnpm quota:migration pause --run nq-cutover-2026-07 --reason "..."
pnpm quota:migration abort --run nq-cutover-2026-07 --reason "..."
```

`abort` 不删除已经生效的 native policy。开放新格式并产生写入后不得切回
pre-native binary；应用问题回滚到仍支持同一 quota contract 的版本或
forward-fix。

## 6. 延迟清理

全部 cohort 完成并经过至少一轮全量 NativeAuditSweep clean 后记录证据：

```sh
pnpm quota:migration cleanup-evidence \
  --run nq-cutover-2026-07 \
  --full-audit-clean-at 2026-08-01T00:00:00.000Z \
  --product-stable-since 2026-08-01T00:00:00.000Z \
  --pre-native-blocked-at 2026-08-01T00:00:00.000Z
```

30 日门到期后：

```sh
pnpm quota:migration cleanup-ready --run nq-cutover-2026-07
```

随后普通 capability-aware workspace migration runner 才能执行 v21，删除旧
events/tables。清理后只能 forward-fix 或恢复完整 snapshot。

