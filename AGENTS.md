# AGENTS.md

Always output zh_CN. You are a TypeScript developer experienced with the Mastra framework. You build AI agents, tools, workflows, and scorers. You follow strict TypeScript practices and always consult up-to-date Mastra documentation before making changes.

## Engineering Guardrails

- Package manager is `pnpm` only. Use `pnpm add`, `pnpm remove`, `pnpm install`, and `pnpm run`.
- Do not introduce or regenerate `package-lock.json` or `yarn.lock`.
- Keep the repository lockfile as `pnpm-lock.yaml` and keep `packageManager` in `package.json` aligned with the installed pnpm major version.
- Repo is pnpm workspaces：`server/` + `web/` + `shared/`。跨包用 `workspace:*` 引用，**不**用相对路径跨包 import。

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## 技术栈

> 2026-05-16 起，**弃用 Electrobun + 嵌入式 SurrealDB**；2026-05-17 起，**前端默认直连 SurrealDB + IdP 接管身份分发**。架构决策见：
> - [`docs/adr/web-only-pivot.md`](./docs/adr/web-only-pivot.md)
> - [`docs/adr/frontend-direct-connect.md`](./docs/adr/frontend-direct-connect.md)（**最新**）
> - [`docs/adr/workspace-as-database.md`](./docs/adr/workspace-as-database.md)
> - [`docs/adr/backend-framework-hono.md`](./docs/adr/backend-framework-hono.md)
> - [`docs/adr/virtual-office.md`](./docs/adr/virtual-office.md)
>
> `docs/adr/sync.md` 已 Superseded（不要再据此开工）。`.scratch/sync-v2/**` 已 Cancelled。

### 架构总览（三角，浏览器分别直连 IdP / SurrealDB / Bun server）

```
Browser (Svelte 5 + RevoGrid + surrealdb-js + oidc-client-ts)
   │
   ├── OIDC Auth Code + PKCE ─────► IdP（外部，身份与 workspace 列表权威）
   │     ↑ token claim 含 current_db / role / ns_admin?
   │
   ├── WSS（surrealdb-js）─────────► SurrealDB（公网 WSS + TLS）
   │     ├ NS-admin access：DEFINE DATABASE（仅创建 workspace 那一刻）
   │     ├ admin access：DDL + DML
   │     ├ participant access：DML（DB 引擎拒 DDL）
   │     └ 所有 SELECT / LIVE / INSERT / UPDATE 直接走这条连接
   │
   └── HTTPS / WSS ───────────────► Bun server (Hono)
                                    ├── POST /api/chat（Mastra Router workflow，LLM key 必须在后端）
                                    ├── WS  /api/chat/stream（workflow 流式输出）
                                    ├── Office dispatcher（进程内服务；用员工 secret SIGNIN ws db）
                                    └── POST /api/internal/*（IdP webhook 同步 _system；root 操作）
                                       SurrealDB root 连接：
                                       • _system schema 启动 / IdP 同步 / dispatcher 启动遍历
                                       • employee_credential 写入
```

**没有了**：sessions / members / workspaces 创建 endpoint、LIVE 转发 endpoint、后端 OIDC 中转——都被浏览器直连或 IdP 取代。

### 各层选型理由

| 层 | 选型 | 理由 |
|---|---|---|
| 前端框架 | Svelte 5 | 编译期信号，无 VDOM，单元格级别更新不触发行重渲染 |
| Grid 组件 | RevoGrid | Web Component，框架无关，活跃维护，虚拟滚动，Excel TSV 剪贴板 |
| Excel 导入 | SheetJS (xlsx 社区版) | 解析 .xlsx 后写入数据表 |
| 前端构建 | Vite 8 | 标准 SPA，无 SSR；dev 代理 `/api`、`/ws` 到 Bun server |
| 前端 ↔ SurrealDB | WSS（surrealdb-js 浏览器 SDK） | 浏览器直连，读 / 写 / LIVE / DDL（admin）全在浏览器 |
| 前端 ↔ 后端 | HTTPS + WS（Hono RPC client） | 仅 Mastra `/api/chat*` 等少数 endpoint；端到端类型走 `hono/client` |
| 前端 ↔ IdP | OIDC Auth Code + PKCE（oidc-client-ts） | 浏览器直接走，不经过后端；token 中带 current_db / role |
| 后端运行时 | Bun | 统一 TS 运行时，承载 Mastra + Hono + SurrealDB SDK |
| 后端框架 | Hono | Bun 事实标准、WS 一等支持、中间件精简、不锁运行时（详见 ADR） |
| OIDC 校验 | jose + JWKS（5min cache） | 后端不维护 session 表，OIDC token 透传到 SurrealDB |
| AI Agent | Mastra | 在 Bun server 进程内作为库使用；Router workflow + 自治 dispatcher 并列 |
| 数据库 | 自部署 SurrealDB（公网 WSS + TLS，可选 IP 白名单 / WAF） | 每 workspace 一个 database，DB 边界天然隔离；浏览器直连 |
| DDL / DML 权限 | DB 引擎层 `DEFINE ACCESS` 硬隔离 | admin (JWT) 有 DDL；participant / employee (RECORD) 仅 DML |
| 实时数据推送 | SurrealDB LIVE SELECT 浏览器直接订阅 → Svelte `$state` | 一条 LIVE 查询驱动一个视图的响应式更新；**后端不参与 LIVE 转发** |

### 产品核心约束（影响所有技术决策）

**表格 = 数据库表，操作 = 查询**

- 每个 Grid 的列 → `DEFINE FIELD`，列类型直接约束前端输入
- 单元格公式 → SurrealQL，在 Bun server 内以调用者会话执行，结果通过 HTTP/WS 推回浏览器
- 聚合/统计操作 → 真实 SurrealQL（GROUP BY、COUNT、SUM），不是 JS 模拟
- Mastra 能力 → AI 生成 SurrealQL，以**调用者会话**操作数据库表结构和数据（管理员才能 DDL）

**身份模型（不可违背）**

- 用户**默认直连 SurrealDB**——读 / 写 / LIVE / 管理员 DDL 全在浏览器内做。
- 后端唯一长期凭证是 SurrealDB **root**（环境变量），仅用于：启动期 `_system` schema、`employee_credential` 写入、接收 IdP webhook 同步 `_system`、dispatcher 启动遍历。
- 真人会话 = 浏览器用 IdP 颁发的 OIDC token `db.signin` 到 ws db 的 `admin` 或 `participant` access。
- NS-admin 会话 = 仅 create-workspace 那一刻临时 token，浏览器在 NS 级 `admin` access signin 后 `DEFINE DATABASE`。
- 虚拟员工会话 = dispatcher 用员工 secret SIGNIN 到 ws db 的 `employee` access。
- IdP 是 workspace 列表与切换的权威；后端 `_system.user_workspace_index` 是 IdP 同步缓存。
- **架构内不存在 service JWT 概念**。所有写入归因走 `$auth`，不要在表字段里手工标 `from_*`。
- **execTemplate 概念已废除**。workspace 创建 = IdP 颁发 NS-admin token + 浏览器 DEFINE DATABASE。

## SurrealDB Rules

Any time you write SurrealQL — schema, queries, or permissions — you MUST invoke the `surrealdb` skill FIRST and follow its rules.

Past solutions are documented in `docs/solutions/` (organized by category, searchable by `module`, `tags`, `problem_type`; covers schema design, integration issues, tooling APIs, and architecture patterns). Relevant when implementing features, debugging issues, or integrating third-party libraries in documented areas.

Key rules to internalize:

只有当关系本身是业务实体（有属性、有生命周期、有双向遍历需求）时才用边；否则用字段。
系统结构关系（层级归属、所有权）用字段，用户业务关系（公司持股、案件关联）用边。

- 执行语句时不要直接写query，明确insert/update/delete，明确是操作的recordId还是table
- 数据库的id类型在传递给数据库时，必须用RecordId类型或new StringRecordId(id)包裹。
- 对于数据库已经定义了的实体对象，应该在代码中统一定义对象类型，不应该在泛型里定义类型
- 使用surrealdb的sdk执行操作，数据库定义是什么类型的字段则在ts中也必须是相应的数据类型，比如schema的field类型是datetime，则ts必须是DateTime类型
- 带有唯一索引的表在写入数据时，必须使用`ON DUPLICATE KEY UPDATE` 来处理冲突，且不必再查询是否存在后update

### 跨 workspace 隔离由 db 边界天然保证

每个 workspace 是独立 SurrealDB database，跨 workspace 隔离**不靠** PERMISSIONS 嵌套子查询，**靠** db 边界。这意味着业务表的 PERMISSIONS 只需要表达"在本 workspace 内你对这条记录的角色"——不需要再写 `workspace IN $auth<-...->workspace` 这种嵌套。常见范式：

```surql
-- 同 workspace 任何登录用户可见
FOR select WHERE $auth != NONE
-- 仅记录创建者或管理员可改
FOR update WHERE assigner = $auth OR $auth.is_admin = true
-- 仅管理员可建（DDL 由 DB 引擎层 access 类型卡死）
FOR create WHERE $auth.is_admin = true
```

### Permissions belong in the schema, never in queries

Row-level security is defined once in `DEFINE TABLE ... PERMISSIONS` and enforced by the database engine. Frontend / backend tool queries must NOT contain auth-filtering conditions (`WHERE user = $auth` 等)。引擎已经强制 PERMISSIONS，查询里再加是冗余的、误导的；查询只携带"用户驱动的过滤选项"（status、日期、搜索词等）。

### 三类身份的 access 与能力

| 身份 | 走的 access | DB 引擎能力 | 谁持 token |
|---|---|---|---|
| **NS-admin**（仅 create-workspace 临时） | `admin` ON NAMESPACE (TYPE JWT) | DEFINE DATABASE + 跨 db DDL | 浏览器（IdP 颁发临时 token） |
| **工作区管理员**（`user.kind='human' AND is_admin=true`） | `admin` ON DATABASE (TYPE JWT) | DDL + DML | 浏览器 |
| **普通成员**（`user.kind='human' AND is_admin=false`） | `participant` ON DATABASE (TYPE RECORD WITH JWT) | 仅 DML（DDL 被引擎硬拒） | 浏览器 |
| **虚拟员工**（`user.kind='virtual'`） | `employee` ON DATABASE (TYPE RECORD) | 仅 DML（DDL 被引擎硬拒） | dispatcher（后端进程内）用员工 secret SIGNIN |

完整 access SurrealQL 与 AUTHENTICATE 脚本见 [`docs/adr/workspace-as-database.md`](./docs/adr/workspace-as-database.md) §1。

## CRITICAL: Load `mastra` skill

**BEFORE doing ANYTHING with Mastra, load the `mastra` skill FIRST.** Never rely on cached knowledge as Mastra's APIs change frequently between versions. Use the skill to read up-to-date documentation from `node_modules`.

## Project Overview

This is a **Web app**：Svelte 5 前端 + Hono on Bun 后端 + 自部署 SurrealDB。后端承载 Mastra（Router workflow + 自治办公室 dispatcher）。

## Project Structure

> 仓库正在按 `.scratch/wp-restructure/` 计划迁到 pnpm workspaces。迁移完成前 `src/main/**` 与 `src/renderer/**` 暂以 `server/legacy/` 与 `web/legacy/` 形态存在，新代码请按"目标位置"列写。

| 目标位置 | 描述 |
| --- | --- |
| `server/`                    | 后端 workspace（Hono on Bun） |
| `server/src/index.ts`        | 进程启动（init root 连接 / ensure system schema / migrate workspaces / Bun.serve） |
| `server/src/app.ts`          | Hono app 装配 + 全局中间件 |
| `server/src/middleware/`     | OIDC verify（仅 Mastra 用）、IdP webhook HMAC、日志、错误归一 |
| `server/src/db/`             | SurrealDB root 连接管理、_system schema 初始化、迁移 runner、reconciler |
| `server/src/routes/`         | HTTP / WS endpoints：仅 `/api/chat*`（Mastra）+ `/api/internal/*`（IdP webhook + dispatcher 内部入口）+ `/health` |
| `server/ai/mastra/`          | Router workflow + 子 agent + tool（迁自 `src/main/ai/mastra/`） |
| `server/ai/mastra/agents`    | 子 agent 定义（navigation / dashboard / claim-analysis / resource-retrieval / chitchat） |
| `server/ai/mastra/workflows` | Router workflow 与未来 employee workflow |
| `server/ai/mastra/tools`     | 所有 tool；调用 SurrealDB 时必须用 `context.surrealSession`，禁止 root / service |
| `server/ai/mastra/storage`   | `WorkflowsStorage` adapter，落 `_system.workflow_run` |
| `server/ai/office/`          | 虚拟办公室 dispatcher、employee runtime、tool bundles（待 virtual-office 簇开工） |
| `web/`                       | 前端 workspace（Svelte 5 + Vite 5） |
| `web/src/`                   | 业务 UI |
| `web/src/lib/api.ts`         | Hono RPC client；仅对接 Mastra `/api/chat*` |
| `web/src/lib/ws.ts`          | WS 客户端封装（仅 Mastra stream） |
| `web/src/lib/auth.ts`        | OIDC SPA 登录壳（oidc-client-ts）+ silent refresh + claim 解析 |
| `web/src/lib/surreal.ts`     | 浏览器 surrealdb-js 直连封装；按 IdP token signin admin / participant |
| `web/src/lib/workspace-store.ts` | 当前 workspace + db 连接状态（$state runes） |
| `web/src/lib/switch-workspace.ts` | 调 IdP silent refresh 切 workspace + 重新 signin |
| `web/src/lib/create-workspace.ts` | 拿 NS-admin token + DEFINE DATABASE + 应用模板 |
| `web/src/routes/auth/`       | login / callback 页 |
| `web/src/components/`        | RevoGrid 包装、AI 抽屉、Workspace 切换器、办公室 UI |
| `shared/`                    | 前后端共享类型 / DTO（含 `router-workflow.types.ts`、`ai-context.ts`） |
| `shared/sql/system/`         | `_system` schema 增量（按版本号排序的 .surql） |
| `shared/sql/workspace-template/` | workspace database 模板增量（含三条 access + user + office_role + employee_credential） |
| `schema/`                    | 历史 SurrealQL 全量定义；新增量请走 `shared/sql/**`，本目录视为参考 |
| `docs/adr/`                  | 架构决策记录（Accepted / Superseded 状态见每篇 header） |
| `docs/agents/`               | 仓库内 skill 约定（issue-tracker、triage-labels、domain） |
| `.scratch/<feature>/`        | 每个 feature 一个目录：PRD.md + issues/NN-*.md |

### Top-level files

| File | Description |
| --- | --- |
| `package.json`        | 仓库根仅放 devDependencies / 聚合 scripts；业务依赖落在各 workspace |
| `pnpm-workspace.yaml` | 列出 `server` / `web` / `shared` 三个 workspace |
| `Dockerfile`          | 多阶段构建（builder + runtime），输出单镜像 |
| `docker-compose.yml`  | 开发用：`server` + `surrealdb` 两服务同网段 |
| `.env.example`        | 环境变量模板。**不要**提交真实 secret |
| `tsconfig.json`       | 仅 IDE 锚点；真正的 tsconfig 在各 workspace 内 |

### 环境变量约定

后端启动需要：

- `PORT`（默认 8080）
- `SURREAL_URL`（如 `wss://db.example.com/rpc`） / `SURREAL_NS=main` / `SURREAL_ROOT_USER` / `SURREAL_ROOT_PASS`
- `OIDC_ISSUER` / `OIDC_JWKS_URL` / `OIDC_AUDIENCE`（仅 Mastra endpoint 验 token 用）
- `IDP_WEBHOOK_SECRET`（IdP webhook HMAC 校验）
- `IDP_ADMIN_API_URL` / `IDP_ADMIN_TOKEN`（reconciler 拉 IdP 全量用）
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等模型 provider key

前端构建需要：

- `VITE_SURREAL_URL`（如 `wss://db.example.com/rpc`）
- `VITE_OIDC_ISSUER` / `VITE_OIDC_CLIENT_ID` / `VITE_OIDC_REDIRECT_URI` / `VITE_OIDC_AUDIENCE`
- `VITE_OIDC_JWKS_URL`（前端创建新 db 时占位替换模板 SQL）
- `VITE_API_BASE_URL`（Bun server 的对外地址）

## Boundaries

### Always do

- Load the `mastra` skill before any Mastra-related work
- 新 agent / tool / workflow / scorer 在 `server/ai/mastra/index.ts` 中注册
- 新业务 schema 增量以 `.surql` 文件追加到 `shared/sql/workspace-template/`，文件名带版本号——**前后端共享同一份**
- 业务读写 / LIVE 默认前端直连 SurrealDB（用 `getSurreal()`）；后端**只**承载 Mastra、Office dispatcher、IdP webhook、root 维护
- 写 SurrealQL 时用 graph traversal（`->` / `<-`），不要再用 `SELECT VALUE ... FROM edge WHERE in = ...`
- 后端 Mastra tool 调用 SurrealDB 时必须用 `context.surrealSession`（调用者会话），不要用 root 或全局连接
- 任何"管理员能做的事"优先让浏览器直接 SurrealQL 完成（PERMISSIONS 兜底），不要给后端加 endpoint

### Never do

- 不引入 service JWT / 长期员工 token / 任何"代写"模式——只有：浏览器直连会话、dispatcher employee SIGNIN、root 维护
- 不在后端加 sessions / members / workspaces 创建 / LIVE 转发等代理 endpoint——已被前端直连或 IdP 取代
- 不写 execTemplate——concept 已废除，workspace 创建走 IdP + 浏览器 DDL
- 不在 endpoint 代码里手写"`if (!user.is_admin) throw 403`"做 DDL 守卫——access 类型已硬隔离 DDL
- 不在 PERMISSIONS / query 里写 `workspace IN $auth<-...->workspace` 之类的嵌套——跨 workspace 隔离由 db 边界保证
- 不修改 `node_modules` 或 SurrealDB 数据目录
- 不在代码 / 配置 / 日志里硬编码 API key、SurrealDB root 凭证、员工 secret、OIDC client secret
- 不提交 `.env`
- 不再向 `src/main/**` / `src/renderer/**` / `electrobun.config.ts` 路径写新代码——这些路径正在退役

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)

## Agent skills

### Issue tracker

Issues and PRDs for this repo are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

当前正在进行的需求簇（按依赖顺序）：

- `.scratch/wp-restructure/`         — 仓库重组（簇 A）
- `.scratch/server-skeleton/`        — Hono on Bun 骨架（簇 B，依赖 A）
- `.scratch/workspace-as-db/`        — workspace 身份层（簇 C，依赖 B）
- `.scratch/mastra-router-migration/` — Router workflow 迁入（簇 D1，依赖 C）
- `.scratch/web-frontend-migration/`  — 前端迁移（簇 D2，依赖 C；可与 D1 并行）
- `.scratch/virtual-office/`         — 虚拟办公室（簇 E，依赖 D1 + D2）

### Triage labels

This repo uses the default five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout rooted at `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
