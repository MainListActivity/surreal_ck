Status: needs-triage
Label: needs-triage

# WP-D1-03 — Tool 鉴权重写：全部走调用者 session token

## Parent

`.scratch/mastra-router-migration/PRD.md`

## What to build

把所有 tool 的 SurrealDB 调用从"全局连接"改成"接收 SIGNIN 完毕的 session 连接"：

1. Mastra tool 接口扩展：每个 tool 的 execute 接收 `{ context: ToolExecutionContext }`，把 `context.surrealSession` 作为 SurrealDB 调用入口。
2. Router workflow 的 dispatcher 在拉起每个 sub agent 前注入 `surrealSession`：
   - 该 session 是用调用者 OIDC token 走 admin 或 participant access SIGNIN 得到的（`https://surrealdb.com/db` / `https://surrealdb.com/ac` token scope 决定目标 db 与 access，参见 [`workspace-as-database.md`](../../../docs/adr/workspace-as-database.md)）。
   - 通过 Mastra runtime context（参考 mastra skill）传递给 tool。
   - workflow run 结束后该 session 被丢弃；下次调用重新 SIGNIN。
3. 把现有 tool 内任何 `import { db } from '@/main/db'` 之类的硬编码替换为 `context.surrealSession`。
4. 删除任何 service JWT / root 凭证引用。

被改动的文件清单（参考既有结构）：

- `server/ai/mastra/tools/navigation-tools.ts`
- `server/ai/mastra/tools/dashboard-tools.ts`
- `server/ai/mastra/tools/claim-analysis-tools.ts`
- `server/ai/mastra/tools/resource-tools.ts`

## Acceptance criteria

- [ ] 所有 tool 通过 typecheck，且 grep 看不到任何 root / service 凭证使用。
- [ ] 单测覆盖：navigation `searchWorkbook` 用 participant session SELECT workbook 表，PERMISSIONS 拒绝看 admin-only 表（之前用 root 不会触发，现在必须正确）。
- [ ] changefeed 验证：用 admin OIDC 登录，让 Router workflow 跑一遍 dashboard draft → workspace.workbook 表的写入归因到 `$auth = 该 admin user`，不是任何 service。
- [ ] 任何 tool 抛 SurrealDB PERMISSIONS 拒绝 → Router workflow 不崩，把错误转给 chitchat agent 兜底。

## Notes

- 这是 web pivot 的"最后一公里"——pivot ADR 承诺所有写入都以用户身份执行，此 issue 强制兑现。
- 测试时要覆盖 admin 与 participant 两种 session 类型，防止某些 tool 默认假设 admin。
