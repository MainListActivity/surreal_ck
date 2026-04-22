# AGENTS.md

Always output zh_CN.

## Engineering Guardrails

- Package manager is `pnpm` only. Use `pnpm add`, `pnpm remove`, `pnpm install`, and `pnpm run`.
- Do not introduce or regenerate `package-lock.json` or `yarn.lock`.
- Keep the repository lockfile as `pnpm-lock.yaml` and keep `packageManager` in `package.json` aligned with the installed pnpm major version.

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

### 架构总览

```
Electrobun 1.x (桌面壳)
├── Main Process (Bun 运行时)
│   ├── surrealdb-node (embedded，运行在 Bun 进程内)
│   ├── Mastra (AI Agent，已验证在 Bun 下正常运行)
│   └── Electrobun RPC bridge ──→ WebView
└── WebView (系统原生 Chromium / WKWebView)
    ├── Svelte 5 (前端框架，Runes 信号系统，编译期细粒度响应式)
    ├── RevoGrid (Web Component 内核，虚拟滚动，百万级单元格)
    └── SheetJS xlsx (Excel .xlsx 导入解析)
```

### 各层选型理由

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Electrobun 1.x | 全 TS+Bun 栈，无 Rust，系统 WebView，包体小 |
| 主进程运行时 | Bun | 统一运行时，承载 DB + AI + RPC |
| 数据库 | surrealdb-node (embedded) | 无外部进程，直接 in-process，零网络开销 |
| AI Agent | Mastra | 运行在 Bun 内，已验证兼容 |
| 前端框架 | Svelte 5 | 编译期信号，无 VDOM，单元格级别更新不触发行重渲染 |
| Grid 组件 | RevoGrid | Web Component，框架无关，活跃维护，虚拟滚动，Excel TSV 剪贴板 |
| Excel 导入 | SheetJS (xlsx 社区版) | 解析 .xlsx 后注入 RevoGrid |
| 主进程↔WebView 通信 | Electrobun RPC | 官方机制，不走 HTTP localhost |
| 实时数据推送 | SurrealDB LIVE SELECT → RPC → Svelte `$state` | 一条 LIVE 查询驱动一个表格视图的响应式更新 |

### 产品核心约束（影响所有技术决策）

**表格 = 数据库表，操作 = 查询**

- 每个 Grid 的列 → `DEFINE FIELD`，列类型直接约束前端输入
- 单元格公式 → SurrealQL，在 Bun 主进程执行，结果推回 WebView
- 聚合/统计操作 → 真实 SurrealQL（GROUP BY、COUNT、SUM），不是 JS 模拟
- Mastra 能力 → AI 生成 SurrealQL，操作数据库表结构和数据

### Electrobun 渲染模式说明

Electrobun **不支持 SSR**，只有 WebView 静态包模式：
- 前端代码打包为静态 HTML/JS/CSS，通过 `views://` 协议加载
- 动态数据**全部通过 RPC** 在 Bun 主进程与 WebView 之间传递
- 不走 HTTP localhost，无需本地 HTTP 服务器

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


### Permissions belong in the schema, never in queries

Row-level security is defined once in `DEFINE TABLE ... PERMISSIONS` and enforced by the database engine. Frontend queries must NOT contain auth-filtering conditions (`WHERE user = $auth`, `WHERE in = $auth`, etc.). A query that leaks permission logic into the client is a security defect: the engine enforces PERMISSIONS regardless, so the client filter is at best redundant and at worst misleading.

Frontend queries only carry **user-driven filter options** (e.g. status, date range, search term) that the user controls from the UI.

### Use graph traversal syntax in PERMISSIONS and queries

SurrealDB's `->` / `<-` operators replace verbose `SELECT VALUE ... FROM edge WHERE in = x` patterns. Always prefer graph traversal:

```surql
-- ✗ verbose, non-idiomatic
$auth IN (SELECT VALUE in FROM owns_workspace WHERE out = id)

-- ✓ graph traversal, idiomatic
id IN $auth->owns_workspace->workspace
```

Standard access patterns used in this project:
- Owner check: `id IN $auth->owns_workspace->workspace`
- Member check: `id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace`
- Workbook visibility: `id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook`


