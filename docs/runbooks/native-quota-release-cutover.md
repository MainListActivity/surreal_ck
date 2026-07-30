# Native quota 发布、切换与恢复 Runbook

## 适用范围与不可变前提

本 Runbook 适用于 `MainListActivity/surrealdb` 的
`3.3.0-native-quota.1` 发布线与 surreal_ck 的原生配额切换。它不授权使用
官方 SurrealDB、nightly、tag 或未认证 backend。

每次执行都必须先记录：

- candidate tag、40 位 source SHA、`sha256:` image digest；
- `native-quota-v1.0` compatibility manifest 与 surrealdb-js `2.0.8`；
- RocksDB `native-quota-contract-v1` 认证；
- `_system` 和全部 active workspace 的 snapshot id/checksum；
- 执行人、复核人、变更单和回退负责人。

运行引用只能是：

```text
ghcr.io/mainlistactivity/surrealdb-native-quota@sha256:<64-hex>
```

下游可按项目所有者的明确决定，把 candidate/image 的签名验证记为
`waived_no_certificate`。豁免只覆盖 surreal_ck 下游的两次 verify 操作；digest、
manifest、artifact hash、SBOM、provenance、漏洞、multi-arch、运行时 capability
和 RocksDB 认证仍是硬门禁。生产 acceptance statement 仍由 GitHub OIDC
keyless 签名，SurrealDB promotion workflow 仍会验证候选、镜像和 acceptance
签名；此过程不需要持有长期证书。

## 发布前验收

1. 在 surrealdb fork 的受保护 `releases/sck-3.3` 分支完成 CI 和 candidate workflow。
2. 手动运行 surreal_ck 的
   `.github/workflows/native-quota-release-acceptance.yml`，输入 candidate tag、
   exact SHA 和 exact digest。
3. 首次或无证书环境选择 `waived_no_certificate`，填写原因，并保持
   `dispatch_production=false`。
4. 验收 workflow 必须完成：
   - candidate manifest、CLI、SDK、capability 和全部 hash 交叉校验；
   - amd64/arm64 OCI index、SPDX SBOM、provenance 与 HIGH/CRITICAL 漏洞门；
   - exact digest RocksDB capability smoke；
   - 双仓 E2E、全量 typecheck/test、控制面 lifecycle 集成测试；
   - vanilla 3.2.3 负向启动门；
   - compose digest 解析与应用镜像构建。
5. 在 SurrealDB promotion workflow 中依次完成人工 `canary`、`staging`，确认两个
   signed receipt 已附加到同一 candidate release。
6. 再次运行下游验收，保持相同 tag/SHA/digest，并仅在最终批准后设置
   `dispatch_production=true`。

任何一次重跑出现不同 digest、SHA、release、manifest revision 或 CLI archive，
都视为新的候选，之前的验收与 receipt 不可复用。

## 三阶段切换

### 阶段一：migration-conductor

1. 冻结旧 manual plan 修改和旧 installer 发布。
2. 生成 inventory 与批准后的 assignment manifest。旧 plan/counter/event 仅是
   discrepancy 证据，不能成为 entitlement 或 native ledger 权威。
3. 停止公网 WSS 和写入，生成 snapshot，并在隔离目录完成一次 restore drill。
4. 用 exact digest fork 启动 RocksDB，执行 format migration。
5. 运行：

```bash
pnpm quota:migration inventory --run <run> --draft <draft.json> --out <inventory.json>
pnpm quota:migration import --run <run> --manifest <approved.json>
pnpm quota:migration prepare --run <run> --evidence <maintenance-evidence.json>
pnpm quota:migration assert-reopen --run <run>
```

`prepare` 必须对 `_system` 和所有 active workspace 完成 REBUILD、独立
table/field/record 物理扫描、native usage 核对、policy materialization 与 fresh
INFO readback。只有 `assert-reopen` 成功才允许恢复公网；此时旧 event 仍保留。

### 阶段二：cohort 与产品切换

顺序固定为：

```text
synthetic_internal → one_percent → ten_percent → fifty_percent → remainder
```

- `synthetic_internal`、`one_percent`：至少观察 24 小时；
- `ten_percent`、`fifty_percent`：至少观察 48 小时；
- `remainder`：通过实时门禁后完成，但仍进入全局 30 日稳定窗。

每个 cohort：

```bash
pnpm quota:migration cutover --run <run> --cohort <cohort>
pnpm quota:migration status --run <run>
# 观察窗完成且无 blocking signal
pnpm quota:migration complete-cohort --run <run> --cohort <cohort>
```

cutover 在单个 database transaction 中 generation-guard reassert 完整 native
policy 并删除旧 event。commit unknown 必须通过 INFO、event 缺失状态和独立扫描
三方读回；无法确定时自动暂停，不得假定已提交。

只有全部 active workspace `native_verified` 后，才可以：

- 开放新计划/订阅/override 运营面板；
- 停止旧 manual scripts；
- 发布只连接 native-quota fork 的 surreal_ck 版本；
- 将 compose/生产配置替换为 receipt 中的 exact digest。

### 阶段三：30 日延迟清理

全部 workspace `native_verified` 后记录：

```bash
pnpm quota:migration cleanup-evidence \
  --run <run> \
  --full-audit-clean-at <ISO> \
  --product-stable-since <ISO> \
  --pre-native-blocked-at <ISO>
```

以 `max(all_native_verified_at, product_stable_since) + 30d` 为最早清理时间。到期后：

```bash
pnpm quota:migration cleanup-ready --run <run>
pnpm quota:migration status --run <run>
```

随后才运行 capability-aware v21 cleanup migration，删除旧 events/tables、
installer、常量和字符串错误。snapshot、candidate evidence、production receipt
及上一生产线恢复材料至少保留 90 日。

## 指标与 abort gate

以下任一信号为零容忍，自动 `pause` 当前 cohort：

- `false_negative`
- `counter_mismatch`
- `ledger_corrupt`
- `structured_error_lost`
- `unknown_drift`
- `cross_workspace_leak`
- `recovery_failed`

还必须持续观察：

| 指标 | 晋级门 | 动作 |
| --- | --- | --- |
| capability/startup/uncertified backend 拒绝 | 0 个误放行 | 立即暂停 |
| unresolved commit outcome | 0 | 立即暂停 |
| rebuild 后物理扫描差异 | 0 | 立即暂停 |
| unexpected denial | synthetic 为 0；其余 15 分钟窗口不高于写入的 0.1% | 超阈值暂停 |
| quota conflict | 5 分钟窗口不高于受保护写入的 1%，且 retry exhaustion 为 0 | 超阈值暂停 |
| 写入 p95 | 相对已批准 RocksDB baseline 回归不超过 20% | 超阈值暂停 |
| HTTP/WSS unknown quota mapping | 0 | 立即暂停 |
| 5xx/连接错误 | 不高于切换前基线 + 0.5 个百分点 | 超阈值暂停 |

非 blocking 的 `unexpected_denial` 或 `performance_regression` 也必须写入 signal：

```bash
pnpm quota:migration signal --run <run> --cohort <cohort> --signal <signal.json>
```

## 暂停、恢复、forward-fix 与回退

暂停：

```bash
pnpm quota:migration pause --run <run> --reason "<reason>"
```

恢复前必须：

1. 固化现场与指标窗口；
2. 对受影响 workspace fresh INFO + 独立扫描；
3. 确认没有 false-negative、半切或未知 drift；
4. 通过同一 digest 的修复验证，或发布一个全新候选并重做验收；
5. 写审计原因后执行：

```bash
pnpm quota:migration resume --run <run>
```

不可安全恢复时：

```bash
pnpm quota:migration abort --run <run> --reason "<reason>"
```

默认恢复策略是 forward-fix。允许的进程回退仅限 manifest 明确声明格式兼容的
native-quota release；禁止回退到 vanilla/旧 fork，禁止原地 data-format
downgrade。

数据回退只能：

1. 保持当前 datastore 隔离且只读；
2. 把维护窗前 snapshot 恢复到新的 datastore 路径；
3. 用相同 native candidate 验证 capability、marker、INFO、独立扫描和 E2E；
4. 在变更批准后切换连接地址；
5. 保留故障 datastore 供审计。

不得把 snapshot 覆盖回正在运行的 RocksDB 目录。

## 最终签字

生产 dispatch 前，变更记录必须包含：

- release owner：tag/SHA/digest/receipt 一致；
- database operator：snapshot restore drill、RocksDB marker、REBUILD/scan 一致；
- application owner：双仓 E2E、lifecycle、错误保真和 compose gate 通过；
- billing/operations owner：Plus/Pro/Max、grace、retention、override 预览正确；
- on-call：指标、pause/abort、forward-fix 与联系人已确认；
- signature policy reviewer：`verify_keyless` 或具名的
  `waived_no_certificate` evidence 已归档。

缺任一项不得设置 `dispatch_production=true`。
