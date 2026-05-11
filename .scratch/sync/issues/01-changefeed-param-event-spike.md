Status: ready-for-human
Label: ready-for-human

# SYNC-001 — SurrealDB CHANGEFEED + PARAM + EVENT 三件套 spike

## Parent

`docs/adr/sync.md`

## What to build

ADR 中 echo 防护方案依赖 SurrealDB 的 `DEFINE PARAM`、`DEFINE EVENT`、`CHANGEFEED` 三个特性组合行为。落地前必须用最小可行 demo 验证这些行为在当前安装版本（`surrealdb@^2.0.3` + `@surrealdb/node@^3.0.3`）和远端 SurrealDB Cloud 上一致工作，否则需要回退到“双写入口”模型。

写一个独立 spike 脚本（建议放在 `scripts/sync-spike.ts`），分别在 embedded localdb 和远端 SurrealDB Cloud 上执行同一组验证，产出一份 markdown 报告。

需要验证的命题：

1. `DEFINE PARAM OVERWRITE $current_session_id VALUE "<ulid>"` 设置后，该 PARAM 在当前 Surreal 实例的所有后续查询中可读，且不需要每次查询重新设置。
2. `DEFINE EVENT` 内可以读 `$current_session_id`，并将其写入 record 字段。
3. 业务代码执行普通 `CREATE` / `UPDATE` 时，EVENT 触发，`_origin_session_id` 字段被正确写入。
4. `SHOW CHANGES FOR TABLE xxx SINCE <vs>` 返回的变更体中包含 `_origin_session_id`，可用于过滤。
5. 用 raw query 显式写入 `_origin_session_id = 'remote:<vs>'`（模拟同步层 apply 远端变更）时，EVENT 不会把它覆盖为本地 sessionId。
6. EVENT 内对当前 record 的 UPDATE 不会自循环触发新的 EVENT / CHANGEFEED 条目。
7. `CHANGEFEED` 是否记录由 EVENT 引起的二次字段写入（关系到自循环风险）。

## Acceptance criteria

- [ ] `scripts/sync-spike.ts` 可以独立运行，输入是 surreal cloud 连接字符串 + JWT，输出是 markdown 报告。
- [ ] 报告对上述 7 个命题分别标注 PASS / FAIL / WORKAROUND，每个命题附最小复现片段。
- [ ] 报告给出最终结论：是否可以按 ADR 的 echo 防护方案落地，或需要切换到“双写入口”备选方案。
- [ ] 报告归档到 `docs/adr/sync-spike-report.md`。
- [ ] 如结论为需要回退，ADR `docs/adr/sync.md` 同步更新决策与未决项段落。

## Blocked by

None - can start immediately
