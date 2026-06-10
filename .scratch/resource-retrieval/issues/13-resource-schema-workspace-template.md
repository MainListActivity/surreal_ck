Status: done
Label: done
Category: enhancement

# RR-013 — 资源库 schema 移植到 workspace-template（RR-012 前置）

## Parent

`.scratch/resource-retrieval/PRD.md`

## Why this exists

RR-012 的 Scheduling note 要求：若历史资源 schema/契约尚未移植进 `shared/sql/workspace-template`，先建一个小前置 issue 完成移植。当前状态：

- resource_item / resource_embedding / workspace_embedding_profile / research_session 只存在于 pre-pivot 的 `schema/main.surql`（带 `workspace` 字段、`record<app_user>`、sync 时代 `local_resource_session_link` / `_origin_session_id`）。
- `server/ai/mastra/tools/resource-tools.ts` 的 searchResources / getResourceDetail 因 "schema 未定稿" 抛 TODO。

## What to build

新增 `shared/sql/workspace-template/008-resource-library.surql`（version 8），把四张资源表按 workspace-as-db 约定移植：

- **去 `workspace` 字段**：隔离靠 db 边界，不写 `<-has_workspace_member<-workspace` 嵌套。
- `record<app_user>` → `record<user>`，归因走 `DEFAULT $auth`。
- **不移植** `local_resource_session_link`（ADR sync 已 Superseded；research_session 直接住 workspace db，`created_resources` 数组承载关联）与 `_origin_session_id`。
- PERMISSIONS 按模板范式：
  - `resource_item` / `resource_embedding`：共享库，成员可读写（`$auth != NONE`），删除仅管理员。
  - `workspace_embedding_profile`：成员可读，管理员可写；每 db 单例（约定固定 record id `workspace_embedding_profile:default`，不再需要按 workspace 的唯一索引）。
  - `research_session`：私有检索过程，创建者或管理员可见/可改。
- 保留已验证的领域契约字段：quality 枚举、content/evidence/source hash 去重索引、embedding profile_key + status 枚举（含 `disabled`）、`(resource, profile_key)` 唯一索引。
- 向量字段保留 `array` 形态；HNSW 索引因 DIMENSION 随 profile 而变，不在模板静态定义（留给检索实现按 profile 建）。
- `shared/sql/workspace-template/index.ts` 注册 version 8；`index.test.ts` 按既有模式断言。

## Acceptance criteria

- [x] `loadTemplateScripts()` 按序返回 1..8，`WORKSPACE_TEMPLATE_VERSION = 8`。
- [x] 四张表定义齐全，无 `workspace` 字段、无跨 workspace 嵌套子查询、无 `app_user` / `local_resource_session_link` / `_origin_session_id` 残留。
- [x] PERMISSIONS 符合上述范式，归因字段 `record<user> DEFAULT $auth`。
- [x] `resource_embedding` 保留 `(resource, profile_key)` 唯一索引与 status 枚举。
- [x] `pnpm --filter @surreal-ck/shared test`（或仓库等价命令）通过。

## Implementation notes (2026-06-10)

- TDD 三轮：注册（version 8）→ 四表 + db 边界/归因约定 → embedding/profile 合同；测试在 `shared/sql/workspace-template/index.test.ts`。
- `surreal validate` 通过；shared 38 pass、server 148 pass（含 provisioning 模板应用路径）、shared typecheck 干净。
- 字段类型较 legacy 收紧：`tags array<string>`、`vector array<float>`、`created_resources array<record<resource_item>>`（legacy 因旧库覆盖问题用 `any`，新模板无此包袱）。
- HNSW 向量索引未在模板静态定义（DIMENSION 随 profile 而变），由 RR-012 检索实现按 profile 建。
- `server/ai/mastra/tools/resource-tools.ts` 的 TODO 解除随 RR-012 做，不在本 issue。

## Blocked by

None（D2-07 编辑器底座与 server spine 已就绪）。

## Unblocks

- `.scratch/resource-retrieval/issues/12-web-research-surface-redesign.md`（RR-012）
- `server/ai/mastra/tools/resource-tools.ts` 去 TODO（随 RR-012）
