Status: done
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

- [x] 所有 tool 通过 typecheck，且 grep 看不到任何 root / service 凭证使用。
  - server + shared `tsc --noEmit` 均 0 error；`ai/mastra/tools/*.ts` grep 无 `getLocalDb`/`getRemoteDb`/`getRootConnection`/service JWT，无 `legacy/` import。
- [x] 单测覆盖：navigation `searchWorkbook` 用调用者 session SELECT workbook 表（之前用 root，现在走注入 session）。
  - `navigation-tools-session.test.ts`：唯一匹配 → open-workbook；多匹配 → ambiguous；缺 session → 抛错（不退回 root）。
  - ⚠️ **未做**：真实 participant vs admin-only 表的 PERMISSIONS 拒绝是 DB 引擎行为，需 live SurrealDB 集成测试；本轮以假 session + 抛错替身覆盖到「session 缺失即抛」「query 抛 PERMISSIONS 即向上抛」。留到有 DB 的集成测试簇。
- [ ] changefeed 验证：用 admin OIDC 登录，让 Router workflow 跑一遍 dashboard draft → 写入归因到 `$auth = 该 admin user`，不是任何 service。
  - ⚠️ **未做**：需 live SurrealDB + 真实 OIDC token。session 透传管道已就位（`RouterRuntime.surrealSession` → `executeStep` → `agent.stream({ requestContext })` → tool `getSurrealSession`），归因正确性等集成测试验证。
- [ ] 任何 tool 抛 SurrealDB PERMISSIONS 拒绝 → Router workflow 不崩，把错误转给 chitchat agent 兜底。
  - ⚠️ **本轮未做，刻意推迟**（见下 Notes）。本轮只交付「tool 层正确抛错、不吞」；workflow 层的 chitchat 兜底是独立的编排行为改动。

## 本轮（D1-03）实际交付

- `RouterRuntime` 新增 `surrealSession: Surreal`；`router-chat` 的 `RunRouterChatInput` 同步要求该字段。
- `tool-session.ts`：`getSurrealSession(ctx)` 从 `ctx.requestContext.get(ROUTER_RUNTIME_KEY).surrealSession` 取调用者会话；缺失即抛，**无 root/service 兜底**。
- `navigation-tools` / `dashboard-tools` / `claim-analysis-tools` / `resource-tools` 全部去掉 `legacy/db`、`legacy/services` 耦合：
  - DB 读写改走 `getSurrealSession`（navigation 三个搜索、inspectSchema 读 sheet、analyzeClaimRow/fetchRelatedRecords 读 record/reference）。
  - 纯 intent 构造（generateDashboardDraft 无 preview、createResourceDraftIntent）不碰 session/DB。
  - 资源向量检索 / dashboard preview 等**新 template 尚未定稿的 schema**：取到 session 后明确抛 TODO，**不退回 root/legacy**。
- `agent-executor` 把 `surrealSession` 经新建 `RequestContext`（`ROUTER_RUNTIME_KEY`）透传给 `agent.stream`，tool 才拿得到。
- 新增 workspace-template 增量 `006-tables-grid.surql`（workbook/sheet/dashboard_page）：去掉 `workspace` 字段，隔离靠 db 边界，PERMISSIONS 只表达本 workspace 角色；`surreal validate` 通过。

## Notes

- 这是 web pivot 的"最后一公里"——pivot ADR 承诺所有写入都以用户身份执行，此 issue 强制兑现。
- 测试时要覆盖 admin 与 participant 两种 session 类型，防止某些 tool 默认假设 admin。
- **验收 #4（chitchat 兜底）刻意推迟**：今天 tool 抛错 → executor 抛 → `executeStep` 抛 → run failed → `runRouterChat` 抛（即 workflow 会"崩"）。要做到"不崩、转 chitchat"需在 `executeStep` 捕获 executor 异常并降级走 `runtime.executors.chitchat`——这是 Router workflow **dispatch 编排的行为改动**，与本 issue 的"鉴权重写"是不同关注点，且 D1 PRD 要求"不改变 Router workflow 业务行为"。**后续单独 issue 处理**（建议：决定 catch 范围是仅 PERMISSIONS 类还是所有 executor 异常；catch 时务必把原始错误记 progress/log，不静默吞）。
- 同理 #2「真实 PERMISSIONS 拒绝」、#3「changefeed 归因」依赖 live SurrealDB，留到集成测试簇；本轮的单测是替身版本，session 透传管道与抛错语义已就位。
