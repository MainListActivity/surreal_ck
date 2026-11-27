Status: needs-info

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

- [ ] 留存老板对 PR `#59` 冻结状态的明确书面裁决（解冻切流或明确新冻结条件）。
- [ ] （解冻路径）完成账本回填与全部 cohort 晋级，附每阶段真实运行日志、零异常回滚记录及 48h 观察窗结论。
- [ ] 生产测试工作区实测证实数据库原生配额策略生效（合规/预警/用满/超额状态与提示准确，既有用户数据完整保留）。
- [ ] `TODOS.md` 与 `EXECUTION_PATH.md` 同步更新为实测状态，不再存在“生产状态未知”的矛盾表述。

**依赖**：P-01 首份生产异地备份与异机恢复回执已齐，生产写入仍须负责人书面解冻。

**验证方式**：生产只读状态核查 + 老板裁决记录 + Runbook 分阶段运行回执。

## 2026-11-27 UTC 生产只读基线

- `main` 命名空间共 59 个库。已确认 5 个库有原生配额策略且 `usage_trusted: true`，51 个库尚无原生策略，余下 3 个库未在本次摘要中分类。核对范围内 `UNTRUSTED_COUNT: 0`。
- `quota_migration_run` 仅有 2026-08-30 在 SurrealDB 3.3.0 RocksDB 时期的历史记录。`synthetic_internal` 为 `paused`，其余 cohort 为 `pending`。
- `workspace_quota_runtime` 的 51 个工作区均为 `ledger_state: ready`。本次核对期间 native-audit 持续零报错。`workspace_rollout_gate` 聚合为 4 个工作区开通 `legal_content_access`，3 个开通 `legal_research_ai`。
- P-01 首份生产备份已完成 R2 回读和 15 个 namespace / 72 个 database 的异机恢复验证。[脱敏回执](../../../docs/runbooks/surrealdb-offsite-backup.md#首次生产备份与异机恢复)
- PR #59 已关闭且未合并。书面解冻和新一轮 synthetic 晋级仍待执行。[生产验真记录](../../../docs/runbooks/pilot-production-acceptance.md#原生配额生产只读基线)
