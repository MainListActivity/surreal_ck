Status: done
Label: done
Category: enhancement

# RR-014 — 资源检索服务移植 + router 检索链路接线（RR-012 后续）

## Parent

`.scratch/resource-retrieval/PRD.md`

## Why this exists

RR-012 已落地人工检索 panel 与 SSE 保存路径（资源能进库、带向量），RR-013 已落地 schema。
但检索读路径还停在 pre-pivot：

- `server/ai/mastra/tools/resource-tools.ts` 的 `searchResources` / `getResourceDetail` 仍抛 TODO（拿到调用者 session 后明确拒绝，不回退 root/legacy）。
- `server/src/ai/assemble-mastra.ts` 的 `deps.resource` seam（`ResourceRetrievalExecutorDeps`）未注入——生产 router workflow 不会挂 `resource-retrieval` executor，manual-research suspend / resource-candidates 整条链路只在测试里跑通。
- `resource-agent.ts` 的 `defaultSearchResources` / `defaultGetResourceDetail` / `getDefaultWorkspaceId` 还在动态 import legacy 模块，需随本 issue 删除。

## What to build

把 legacy `server/legacy/services/resources.ts` / `resource-indexing.ts` 中已验证的检索契约移植到 `server/src/resources/`（或同级新模块），全部用**调用者 surrealSession**：

1. **ResourceSearchService**：关键词 contains（title/summary/tags/evidence）+ 向量余弦（服务层计算，可替换接口）+ quality/recency 组合分；`hit` / `candidates` / `miss` 阈值分 band；`indexStatus` 区分 `ready` / `index-disabled`（无 profile）/ `index-pending` / `index-error`。
2. **向量读取按 profile 隔离**：只用 `profile_key = 当前 profile` 且 `status = 'indexed'` 的 `resource_embedding`；HNSW 索引按 profile DIMENSION 建（模板不静态定义，见 008-resource-library.surql 注释），V1 服务层余弦兜底即可。
3. **tool 去 TODO**：`searchResources` / `getResourceDetail` 接真实服务（经 `context.surrealSession`）。
4. **executor 接线**：`assemble-mastra` 注入 `deps.resource`（searchResources + createResearchSession 用调用者 session 写 `research_session`，resolveWorkspaceId 改为从 session/上下文取，删 legacy 动态 import）。
5. **answerResourceSelection 接线**：chat-service / runtime 的 `answerResourceSelection` 用 `getResourceDetail` + `createResourceCitationAnswer`，让 resource-candidates-chosen / manual-research-completed resume 后能产出 citation 回答。
6. （随手）web AiDrawer composer 恢复 RR-011 的「搜索资源」发送模式（`composerMode: "resource-search"` 确定性路由）。

## Out of scope

- BM25 / 中文分词 / 生产级全文索引。
- SurrealDB 原生向量索引强制接入（接口可替换即可）。
- embedding enqueue / retry / reindex endpoint（V1 永久不做，见 RR-012 决策）。

## Test plan

- 检索服务：关键词命中、余弦排序、profile 隔离（不同 profile_key 向量不混入）、阈值分 band、disabled/空库行为——确定性向量，不真调 provider。
- tool/session：`searchResources` 用调用者 session 查询（沿用 resource-tools-session.test.ts 模式）。
- executor：miss → createResearchSession（调用者 session 写入）→ manual-research suspend payload 带真实 sessionId。
- citation：resume 决策后 answerResourceSelection 产出 `[1]` 文本 + 结构化 citations。

## Blocked by

None（RR-012 / RR-013 已 done）。

## Comments

**2026-06-11 — done（TDD 全链路落地）**

落地内容（与 What to build 六项一一对应）：

1. **ResourceSearchService** → `server/src/resources/resource-search.ts`：
   `createResourceSearchService({ session, embeddingProvider?, now? })`，关键词 contains +
   服务层余弦 + quality/recency 组合分（权重沿用 legacy 0.45/0.35/0.12/0.08）；
   hit/candidates/miss 阈值 band（默认 0.72/0.25 可覆盖）；indexStatus 四态齐备。
2. **profile 隔离**：向量读取 `WHERE profile_key = $profileKey AND status = 'indexed'`；
   provider 缺席 / 零命中时按 embedding 行状态推断 index-pending / index-error。
3. **tool 去 TODO**：`searchResources` / `getResourceDetail` 经 `context.surrealSession`
   接真实服务；查询向量 provider 走 `createDefaultEmbeddingProvider()`（env EMBEDDING_API_KEY）。
4. **executor 接线**：`assemble-mastra` 默认注入 `createCallerSessionResourceDeps`（未显式
   传 resource deps 时生产 router 也挂 resource-retrieval）；deps 签名加 session 第二参，
   executor 透传 `SubAgentInput.surrealSession`；`resolveWorkspaceId` 默认 `session::db()`；
   resource-agent 的 legacy 动态 import 全删（卫兵测试看住）；`createResearchSession`
   用调用者 session CREATE，归因靠 schema DEFAULT $auth（不手写 created_by）。
5. **answerResourceSelection 接线**：runner / resumer 都用本 run 的调用者 session 构造
   citation 回答器（`answerSelectedResourceIds` + `getResourceDetail`），
   resource-candidates-chosen / manual-research-completed resume 后产出 `[1]` 文本 + 结构化 citations。
6. **composerMode**：web AiDrawer composer 加「搜索资源」切换 →
   `POST /api/chat body.composerMode` → chat-service 译为
   `planOverride [{category:"resource-retrieval"}]`（确定性路由，不经 LLM classifier）。

测试：`server/src/resources/resource-search.test.ts`（10 用例：关键词命中 / 余弦排序 /
profile 隔离 / band / disabled / pending / error / 详情 / 会话创建）+ tools session 用例 +
executor session 透传 + assemble 装配 + chat-service planOverride + 路由透传 + web drawer。
全仓：server 176 pass / web 244 pass / shared 43 pass，tsc + svelte-check 0 错误。

仍然没有：embedding enqueue/retry/reindex endpoint、BM25/分词、HNSW 强制接入（接口可替换）。
