# 接下来要做

更新时间：2026-05-16

本文是仓库级的下一步工作索引。详细需求、验收条件和讨论记录仍放在 `.scratch/<feature>/issues/*.md`；这里只维护当前优先级、开工顺序和容易忘掉的跨主题风险。

## 维护规则

- 新的可执行事项优先写成 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- issue 状态使用 `docs/agents/triage-labels.md` 中的五个状态：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；完成后可直接标为 `done`。
- 本文只列"下一批要做"和"暂缓原因"，不要复制 issue 的完整验收清单。
- 每次完成一个 issue 后，同步更新本文的"当前主线"和"下一批候选"。

## 当前主线：Web pivot 实现路线（5 个需求簇 + 虚拟办公室）

总体形态依据：
- [`docs/adr/web-only-pivot.md`](./docs/adr/web-only-pivot.md)（部署形态）
- [`docs/adr/workspace-as-database.md`](./docs/adr/workspace-as-database.md)（workspace ↔ database 映射 + 用户身份）
- [`docs/adr/backend-framework-hono.md`](./docs/adr/backend-framework-hono.md)（后端框架）
- [`docs/adr/virtual-office.md`](./docs/adr/virtual-office.md)（业务能力）

实现拆为 5 个需求簇，按严格顺序解锁：

```
A. wp-restructure          (仓库重组)
       ↓
B. server-skeleton         (Hono on Bun 骨架 + OIDC + root 连接)
       ↓
C. workspace-as-db         (_system + ws db 模板 + sessions / members endpoints)
       ↓
D1. mastra-router-migration (Router workflow 迁入后端，用调用者 session 跑)
D2. web-frontend-migration  (Svelte 5 前端迁入，接 Hono HTTP/WS)
       ↓
E. virtual-office          (虚拟员工、岗位、办公室 UI ……)
```

D1 / D2 可在 C 完成后并行；E 必须 D1 + D2 都完成。

### 簇 A — 仓库重组

依据：`.scratch/wp-restructure/PRD.md`

把仓库拆成 pnpm workspaces（server / web / shared），把 `src/main` `src/renderer` `src/shared` 搬到 legacy 目录，Electrobun 退役。5 个 issue。

### 簇 B — 后端骨架

依据：`.scratch/server-skeleton/PRD.md`

Hono on Bun 起服务、OIDC verify 中间件、SurrealDB root 连接管理、/health、Dockerfile。5 个 issue。

### 簇 C — workspace-as-database 身份层

依据：`.scratch/workspace-as-db/PRD.md`

`_system` schema 自动 seed、workspace 模板 SQL 文件、`create_workspace` execTemplate、sessions / members endpoint、schema migration runner、reconciler。7 个 issue。

### 簇 D1 — Router workflow 迁入后端

依据：`.scratch/mastra-router-migration/PRD.md`

把现有 Mastra Router workflow + 子 agent + tool 物理迁入 `server/ai/mastra/`，所有 tool 改为接收调用者 session token；WorkflowsStorage 落 `_system`；暴露 `POST /api/workspaces/:slug/ai/chat` + `WS /api/workspaces/:slug/ai/stream`。6 个 issue。

### 簇 D2 — 前端迁移

依据：`.scratch/web-frontend-migration/PRD.md`

把 `src/renderer` 搬到 `web/`，标准 Vite 5 构建，OIDC 登录壳，workspace 切换器，AI 抽屉接 D1 endpoint。7 个 issue。

### 簇 E — 虚拟办公室

依据：`.scratch/virtual-office/PRD.md`

11 个 issue，按 PRD 路线图。D1 + D2 完成后才能开工。

## 已 Cancelled / Superseded

### 同步 v2

- 整体取消，原因：Web pivot 后只有一个 SurrealDB Cloud 实例，无双库可同步。
- `.scratch/sync-v2/**` issue 文件保留作为决策史，**不再开工**。
- `docs/adr/sync.md` 已标 Superseded。

### Electrobun sidecar 窗口

- `.scratch/agentic-ai-product/issues/09-sidecar-window.md` 取消，Web 浏览器无 sidecar 概念。

### 既有 AI 产品层剩余 issue

依据：`.scratch/agentic-ai-product/PRD.md`

迁移到 Web 后端后，下列 issue 仍有价值（Router workflow 本身保留并迁移），可在迁移完成后继续推进：

1. `.scratch/agentic-ai-product/issues/07-context-snapshot-tests.md`
   补 AI 上下文快照测试。**注意**：context 字段集合在 Web 形态下需要重新评估（无 sidecar / 桌面端 route 概念），可能要瘦身。
2. `.scratch/agentic-ai-product/issues/06-claim-row-analysis.md`
   债权行分析 tool。迁移后照常推进。

## 长线风险和预发布事项

这些不是当前主线，但上线前需要回看。

### 中国法律数据合规

- 优先级：P1 / pre-launch
- 状态：Not started
- 原因：自部署 SurrealDB（同机房内网）已经把数据控制权收回，但仍需在国内法律实体下完成数据本地化部署的工程项 + 法务审阅。
- 范围：法律案件数据是否属重要数据 / 国内数据中心选址 / 法务合同条款。
- 建议：单独立项 ADR + 法务咨询。

### SurrealDB root 凭证管理

- 优先级：High
- 状态：Not started
- 原因：后端唯一长期凭证；仅 `create_workspace` execTemplate 使用，但泄露等于全部 workspace 可破。
- 范围：环境变量管理 + 不写日志 + 文档化轮换流程；后续考虑短期 token 或密钥管理服务。

### OIDC 接入与 DEFINE ACCESS 配置

- 优先级：High
- 状态：Not started
- 原因：所有用户登录与 `DEFINE ACCESS member ON DATABASE TYPE JWT URL ...` 都依赖一个稳定的 IdP。
- 范围：选定 OIDC provider（自部署 Keycloak / 商用 IdP）、JWKS URL、AUTHENTICATE query 模板、跨 workspace AUTHENTICATE 行为单测。

### Schema 迁移 runner

- 优先级：High（launch-critical）
- 状态：Not started
- 原因：业务表 schema 升级要遍历所有 workspace database 跑迁移；缺失则任何一次后端升级都可能让一部分 ws db 状态不一致。
- 范围：启动时遍历 `_system.workspace` → 逐 db 检查 schema_version → 应用增量；失败显式上报。

### 文件上传磁盘满错误处理

- 优先级：Medium
- 状态：Not started
- 原因：磁盘满时静默失败会导致客户文件丢失，属于法律数据完整性风险。
- 范围：上传前检查可用磁盘空间，空间不足时返回明确错误并记录日志。

### `GRAPH_TRAVERSE` 计算字段重算防抖

- 优先级：Medium
- 状态：Not started
- 原因：`LIVE SELECT` 同时触发大量计算字段重算可能冻结 UI 或压垮 SurrealDB。
- 范围：批量收集 dirty 计算字段，在 500ms 静默期后统一重算。

### 异地备份

- 优先级：P2，pre-launch
- 状态：Not started
- 范围：SurrealDB Cloud 数据导出到 S3 / 第二主机，并验证恢复流程。

### 表单防滥用

- 优先级：P2，pre-launch
- 状态：Not started
- 范围：服务端 Turnstile 校验，以及 nginx 或 Cloudflare 层限流。

### 审计轨迹 UI

- 优先级：P3，post-MVP
- 状态：Not started
- 范围：在表格 UI 中提供 History 面板，按选中单元格或记录查看 mutation 轨迹。
