# AGENTS.md

始终使用简体中文。遵循严格 TypeScript 类型约束。

## 开发约定

- Shell 命令遵循 `@/Users/y/.codex/RTK.md`。
- 仅用 pnpm；版本以根 `package.json` 的 `packageManager` 为准，保留 `pnpm-lock.yaml`，不生成 npm / yarn 锁文件。
- Workspace 以 `pnpm-workspace.yaml` 为准；跨包依赖用 `workspace:*`，通过包导出引用，不用跨包相对路径。
- 修改 Mastra 前加载 `mastra` skill，先查安装版本的 `node_modules` 文档。
- 编写或修改 SurrealQL 前加载 `surrealql` skill；其他任务按当前可用 skill 的适用范围选择。
- 不修改 `node_modules` 或数据库数据目录；不提交 `.env`，不在代码、日志或前端 `VITE_*` 中放 secret。
- 按改动范围运行相关测试、类型检查和 lint；命令以各包 scripts 与 CI 为准。

## 部署拓扑与跨仓依赖

本仓库是 Web 应用，依赖两个独立项目：

- **ma_hono（认证 / IdP）**：相邻仓库 `../ma_hono`，提供 OIDC、JWKS、token 签发与 scope exchange；本应用维护 workspace scope，并通过 default-scope hook 供 IdP 查询。
- **自有 SurrealDB fork**：相邻仓库 `../surrealdb`，远端 `MainListActivity/surrealdb`；应用依赖其原生配额能力，不能替换成官方 vanilla SurrealDB。

生产拓扑（地址和发布配置见下方 runbook）：

```text
浏览器
  ├─ HTTPS → Cloudflare Pages
  │            ├─ web：Svelte 5 应用（l.maplayer.top）
  │            └─ marketing：Astro 营销站（www.maplayer.top）
  ├─ OIDC / PKCE → ma_hono（o.maplayer.top/t/ck）
  ├─ WSS /rpc → SurrealDB fork（data.maplayer.top）
  │              ├─ _system：workspace 索引与平台控制面
  │              ├─ 每 workspace 一个 database：业务数据与 workflow 状态
  │              └─ platform_content：独立平台内容库
  └─ HTTPS / WS → Hono edge Worker（l.maplayer.top）
                    └─ Bun + Hono origin（主机侧）
                         ├─ workspace / 成员 / scope、OIDC token exchange
                         ├─ AI、资源保存、office dispatcher
                         └─ 配额控制面、平台内容与运营 API / MCP

ma_hono ── default-scope hook → Bun server
Bun server ── scope exchange / JWKS / introspection → ma_hono
Bun server ── 调用者 / employee / publisher 会话、root 维护 → SurrealDB fork
```

- Cloudflare 发布负责静态站点和边缘代理；Bun origin、SurrealDB 与 ma_hono 独立部署。生产浏览器直连数据库使用 WSS + TLS。
- 本地 `docker-compose.yml` 只启动 server + SurrealDB；认证需另行接入 ma_hono，前端按各包 dev script 启动。
- 数据库镜像必须来自发布 receipt，设置 `SURREALDB_NATIVE_QUOTA_IMAGE=ghcr.io/mainlistactivity/surrealdb-native-quota@sha256:<digest>`；启动 capability / backend 认证失败即拒绝启动。
- 调整部署读 [production-release.md](docs/runbooks/production-release.md)；升级 fork 或切换原生配额读 [native-quota-release-cutover.md](docs/runbooks/native-quota-release-cutover.md)，迁移旧数据另读 [native-quota-legacy-migration.md](docs/runbooks/native-quota-legacy-migration.md)。配置项以 `.env.example` 为准。

## 数据与身份边界

- **表格就是数据库表，操作就是查询**：列类型由 schema 约束，聚合与公式使用真实 SurrealQL。
- 业务读写、LIVE 和管理员 DDL 默认由浏览器通过 `getSurreal()` 直连；后端不增加工作簿 / 数据表 / office 业务 CRUD 或 LIVE 转发代理。
- Workspace 按 database 隔离；workspace 创建、切换、成员索引及 scope 分发走后端 Workspace Scope Module。
- 真人 token 使用短 claim `db` / `ac`；`admin` JWT access 解释 `RL=["Owner"]`，拥有 DDL + DML；`participant` RECORD access 仅 DML，携带 RL 不代表获得 system role。
- 虚拟员工通过 employee secret SIGNIN；AI 工具和资源保存用调用者会话（`context.surrealSession`）；平台内容发布用独立 publisher 会话。不要用 root 代替这些业务身份。
- Root 仅用于明确的平台维护与控制面操作：schema / migration、workspace lifecycle、凭证维护、配额等；不引入 service JWT 或 NS-admin 模式。
- `_system.system_admin` 表非空表示部署级 workspace 创建开关开启，`subject` 只用于 seed / 审计，不是逐人 allowlist。
- 行 / 字段权限统一定义在 schema PERMISSIONS，DDL 能力由 access 类型隔离；业务查询只加用户筛选条件，不重复鉴权过滤或跨 workspace 权限子查询。
- 原生配额由 fork 引擎强制执行；应用侧复用现有 adapter 与共享契约。

## 数据库编码约定

- 优先使用 SDK 的 insert / update / delete，明确操作 table 或 record；ID 用 `RecordId` / `StringRecordId`，datetime 用 SDK `DateTime`，实体类型统一声明。
- 唯一索引写入用 `ON DUPLICATE KEY UPDATE` 处理冲突，不先查询是否存在。
- 归属、层级和所有权用字段；关系有属性、生命周期或双向遍历需求时才建边，查询边用 graph traversal。
- Schema 增量追加带版本号的 `.surql` 到 `shared/sql/` 对应目录；workspace 核心模板、可选模板包、系统库和平台内容库分别维护。

## 代码导航与按需文档

| 目录 | 职责 |
| --- | --- |
| `web/` | Svelte 5 + RevoGrid，浏览器 OIDC / SurrealDB 直连 |
| `server/` | Bun + Hono 后端、Mastra AI、虚拟办公室及平台控制面 |
| `shared/` | 前后端共享类型、数据库 schema 与契约 |
| `marketing/`、`ops/` | Astro 营销站、独立运营前端 |

- 改架构或身份：读 `CONTEXT.md` 与相关 `docs/adr/`；直连和身份重点看 [frontend-direct-connect.md](docs/adr/frontend-direct-connect.md)、[workspace-as-database.md](docs/adr/workspace-as-database.md)。只采用有效决策，`docs/archive/` 仅供历史参考。
- 实现或排障：搜索 `docs/solutions/` 的相关经验。
- 技术需求与 issue：按 [issue-tracker.md](docs/agents/issue-tracker.md) 管理 `.scratch/`，不在此维护需求簇状态。
- 领域文档与 triage：分别读 [domain.md](docs/agents/domain.md)、[triage-labels.md](docs/agents/triage-labels.md)。
