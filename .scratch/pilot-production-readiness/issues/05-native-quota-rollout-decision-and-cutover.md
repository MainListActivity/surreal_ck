Status: ready-for-agent

# 05 · 原生配额生产切流决策解冻与灰度收口

**目标**：消除“生产 SurrealDB 已升级到 `4.0.1-native-quota.1`，但未合并 PR `#59` 仍记录冻结配额三阶段切流”的模糊状态，经老板明确决策后完成真实生产灰度切流，使 Plus / Pro / Max 容量治理真正生效。

## 范围

1. **老板决策确认（前置阻塞解除）**：核实当前生产 `_system` 与各 workspace 的实际配额迁移状态，请老板书面确认解除 PR `#59` 的 2026-09-29 冻结决定，或明确保持冻结的新边界。
2. **按 Runbook 执行分 Cohort 切流**：若解冻，严格按 `docs/runbooks/native-quota-release-cutover.md` 执行账本回填与分批晋级（synthetic → 1% → 10% → 50% → 全量），每阶段保留完整 24h/48h 观察窗与可回退记录。
3. **业务行为复验**：在生产测试工作区验证 Plus / Pro / Max 配额同步、容量预警提示、超额状态阻断净增长（且不删历史数据）以及批量签发前的配额预检拦截。
4. **收口过时记录**：关闭/归档过期 PR `#59`，更新 `TODOS.md` 与 `EXECUTION_PATH.md` 反映真实生产状态。

## 非目标

- 在未获老板明确解冻授权前，不得擅自执行任何生产账本回填或切流写操作。

## 独立验收标准

- [x] 留存老板对 PR `#59` 冻结状态的明确书面裁决（2026-11-28 UTC 老板明确书面解冻授权，按 Runbook 从 `synthetic_internal` 启动灰度切流并严格保留 24h/48h 观察窗）。
- [ ] （解冻路径）完成账本回填与全部 cohort 晋级，附每阶段真实运行日志、零异常回滚记录及 48h 观察窗结论（`synthetic_internal` 31/31 已于 2026-11-28T03:53:29Z 完成并进入 24h 观察窗，余下 16 个 `standard` 工作区待观察窗结束后按 `one_percent → ten_percent → fifty_percent → remainder` 推进）。
- [x] 生产测试工作区实测证实数据库原生配额策略生效（`synthetic_internal` 31/31 与 `_system` 均通过 `REBUILD QUOTA`、`DEFINE QUOTA`、`INFO FOR QUOTA` 回读及独立物理扫描零差异校验，既有数据完整保留）。
- [x] `TODOS.md` 与 `docs/runbooks/pilot-production-acceptance.md` 同步更新为实测状态，不再存在“生产状态未知”的矛盾表述。

**依赖**：P-01 首份生产异地备份与异机恢复回执已齐，老板已书面解冻，当前处于 `synthetic_internal` 24h 强制观察窗。

**验证方式**：生产只读状态核查 + 老板裁决记录 + Runbook 分阶段运行回执。

## 2026-11-27 / 2026-11-28 UTC 生产解冻与 `synthetic_internal` 切流回执

- **历史冻结解冻与基线**：PR `#59` 已于 2026-11-26 关闭未合并；2026-11-28 UTC 老板书面授权解冻并按 Runbook 推进。PR `#335` 修复了 `quota-migration` 盘点对无旧配额表 v21+ 工作区的兼容与串行扫描问题并已部署生产（`Deploy production · 46101441664`）。
- **前置维护证据**：`fork_release: 4.0.1-native-quota.1`、`backend: tikv`、`fork_image_digest: sha256:305f6fbb478b27e7eba59e400435343d745db13d0ad9fe6758cf5ff4a9b16be7`、`snapshot_id: surrealdb-20261127T121836061943Z.cms`（`sha256:b7ca58316ae2edbe7d659dac38143d96dddeb0059e58ce16ade20f940be041e2`）、`restore_drill_completed_at: 2026-11-27T12:57:25Z`；操作主体为老板授权 `platform_operator`（`a7edfa07-6852-4f17-aa18-d9ce760041e1`）。
- **`_system` 与 `synthetic_internal`（31 个工作区）切流实测**：
  - `_system`：`REBUILD QUOTA` + 独立物理扫描零差异（`100 tables / 1305 fields / 56962 records / usage_trusted=true`）。
  - `synthetic_internal` 共 31 个合成/内部工作区全部验收通过：26 个处于 3.3→4.0 TiKV 迁移后 `external_drift` 的工作区完成 `DEFINE QUOTA` 实装 + `QuotaObservationService` 收敛为 `sync_state: in_sync`（连同既有 5 个 `in_sync` 共 31/31 `in_sync`、`usage_trusted: true`），物理扫描零差异。
  - 唯一遗留旧事件工作区 **`442d`（`ws_d286c8bca83d`）**：原子执行 generation-guarded `DEFINE QUOTA OVERWRITE` + 移除 7 张表旧 `resource_quota_guard` 事件，回读确认残留事件为 `0`、`quota_migration_state` 置为 `native_verified`（`32 tables / 78 records / scan_checksum: sha256:622a56475e4ee85a42fedd42e78198b573867563020e313d5820d43721f07941`）。
  - 全局 `workspace_quota_runtime`：`in_sync` 由 `9 → 35`，余下 `16` 个 `standard` 工作区未触碰，严格留待 24h 观察窗后推进。切流后 `https://l.maplayer.top/health` 返回 `status: ok`，`native-audit` 持续 `consecutiveErrors: 0`。
- **强制观察窗与后续计划**：
  - `cutover_completed_at`: `2026-11-28T03:53:29.139Z`
  - `observe_until`（强制 24h）: **`2026-11-29T03:53:29.139Z`**
  - 完整脱敏回执保存在 VPS `/var/lib/surreal-ck-backup/quota-migration-20261128/synthetic-internal-cutover-receipt.json`。观察窗零阻塞信号后，按 `one_percent`（24h）→ `ten_percent`（48h）→ `fifty_percent`（48h）→ `remainder` 依次晋级。[生产验真记录](../../../docs/runbooks/pilot-production-acceptance.md#原生配额生产只读基线)
