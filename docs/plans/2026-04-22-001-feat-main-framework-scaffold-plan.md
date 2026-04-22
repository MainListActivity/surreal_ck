---
title: "feat: 搭建 surreal_ck 主框架骨架"
type: feat
status: active
date: 2026-04-22
---

# feat: 搭建 surreal_ck 主框架骨架

## Overview

从零构建 surreal_ck 的项目骨架。目标是让所有技术层能跑通一个端到端数据流：
Bun 主进程启动 → 加载 SurrealDB embedded → WebView 渲染 Svelte 5 → RevoGrid 展示数据 → RPC 双向通信打通。

本计划不实现任何业务逻辑，只建立可工作的框架基础。

## Problem Frame

仓库当前状态：只有 AGENTS.md / schema/ 文件，无 package.json，无构建配置，无源码结构。`node_modules/` 是残留的孤立安装。需要从头建立完整的项目脚手架，使后续功能开发有可靠的基础。

## Requirements Trace

- R1. Electrobun 1.x 项目可构建、可运行（`pnpm run dev` 启动桌面窗口）
- R2. Bun 主进程嵌入 surrealdb-node，加载 `schema/main.surql` 完成 DDL
- R3. Mastra 核心在 Bun 主进程内初始化（无具体 agent，只验证可导入）
- R4. WebView 加载 Svelte 5 应用，通过 `views://` 协议
- R5. RevoGrid 在 WebView 内渲染，展示静态测试数据
- R6. Bun ↔ WebView RPC 打通：主进程可 push 数据到 WebView，WebView 可发 request 到主进程
- R7. pnpm 作为唯一包管理器，生成 `pnpm-lock.yaml`，无 `package-lock.json`

## Scope Boundaries

- 不实现任何业务功能（用户认证、工作区、表格操作）
- 不配置 LIVE SELECT 实时推送（只验证 RPC 单次通信）
- 不配置代码签名、公证、自动更新
- 不实现 Mastra agent（只初始化核心，验证 import 可用）
- Windows 平台配置暂不在范围内（仅 macOS ARM64）

## Context & Research

### 关键发现

- Electrobun 1.16.0 已在 `node_modules` 中（孤立），重新安装即可
- `@surrealdb/node` 3.0.3 和 `surrealdb` 2.0.3 已存在
- `@mastra/core` 1.25.0 已存在
- Svelte 5、RevoGrid（`@revolist/svelte-datagrid`）、SheetJS **尚未安装**
- `schema/main.surql` 已有完整 DDL，直接加载即可

### Electrobun 核心约束

- `build.views` 的键名 = `views://` URL 的第一段（如 `mainview` → `views://mainview/index.html`）
- `build.copy` 路径必须与 `build.views` 键名一致，否则 404
- RPC 初始化顺序：`defineRPC` → `new BrowserWindow({ rpc })`，`dom-ready` 事件后才能调用 `rpc.request.*`
- `sandbox: true` 会禁用 RPC，不可使用
- pnpm 需要在 `.npmrc` 设置 `shamefully-hoist=true` 确保 `electrobun` bin 可被找到

### surrealdb-node 启动顺序

```
connect(url) → signin({ username, password }) → use({ namespace, database }) → query(schemaSql)
```

`schema/main.surql` 已定义 `DEFINE ACCESS madocs`（JWT OIDC），加载时不影响 embedded 模式的 root 登录。

### Svelte 5 关键配置

- `vite.config.ts` 中 `compilerOptions.runes: true` 全局启用 runes 模式
- tsconfig 需要 `verbatimModuleSyntax: true` 和 `moduleResolution: "bundler"`

### RevoGrid 关键约束

- `source` 更新必须赋新数组引用（`source = [...source, row]`），不能 mutation
- 事件名全小写无连字符：`beforepaste`、`beforepasteapply`、`afterpasteapply`

## Key Technical Decisions

- **单包结构**：不使用 pnpm workspace/monorepo。Electrobun 期望固定目录结构，单包足以用 deps/devDeps 区分前后端。
- **双 tsconfig**：根 tsconfig（主进程 Bun 目标）+ `src/renderer/tsconfig.json`（WebView DOM 目标），通过 `extends` 共享基础配置。
- **Vite 只负责前端 bundle**：`src/renderer/` 是 Vite root，输出到 `dist/`，Electrobun `build.copy` 将其映射到 `views://mainview/`。
- **RPC 类型共享**：`src/shared/rpc.types.ts` 定义双侧类型，主进程和 WebView 各自 import，保持类型安全。
- **DB 模块单例**：`src/main/db/index.ts` 导出 `db` 实例，主进程其他模块通过 import 使用，不传参。
- **pnpm `.npmrc`**：设置 `shamefully-hoist=true` 解决 Electrobun CLI bin 解析问题。

## Open Questions

### Resolved During Planning

- **Bun 是否兼容 @surrealdb/node NAPI**：兼容，官方文档确认 Bun 1.x 支持，`@surrealdb/node` 3.x 官方支持 Bun。
- **Mastra 在 Bun 下运行**：用户已验证可行。
- **RevoGrid Svelte 5 支持**：`@revolist/svelte-datagrid` v4.11.0+ 支持 Svelte 5。

### Deferred to Implementation

- Windows 平台打包配置（WinGet / NSIS installer）
- LIVE SELECT → RPC 实时推送完整实现（Unit 6 只做静态验证）
- Mastra agent 具体定义和工具注册
- SurrealDB 生产环境持久化路径配置（当前用 `surrealkv://./data/app.db`）

## High-Level Technical Design

> *此图为方向性说明，非实现规范。实现时以实际 Electrobun API 为准。*

```
pnpm run dev
    └─ vite build --watch (src/renderer → dist/)
    └─ electrobun dev --watch
           └─ Bun bundle (src/main/index.ts → app/bun/main.js)
           └─ copy (dist/ → app/views/mainview/)
           └─ launch .app
                  ├─ Main Process (Bun)
                  │    ├─ initDb()          → SurrealDB embedded (surrealkv)
                  │    ├─ initMastra()      → @mastra/core 初始化
                  │    ├─ defineRPC(...)    → RPC handlers 注册
                  │    └─ new BrowserWindow → 窗口 + views://mainview/index.html
                  └─ WebView
                       ├─ Electroview.defineRPC → RPC 客户端
                       ├─ App.svelte ($state rows)
                       └─ <RevoGrid source={rows} columns={columns} />
```

## Implementation Units

- [ ] **Unit 1: 项目基础配置**

**Goal:** 建立 package.json、tsconfig、.npmrc，使 pnpm install 可成功运行并生成 pnpm-lock.yaml

**Requirements:** R7

**Dependencies:** 无

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`（主进程 Bun 目标）
- Create: `tsconfig.renderer.json`（WebView DOM 目标，extends tsconfig.json）
- Create: `.npmrc`（`shamefully-hoist=true`）
- Modify: `.gitignore`（确保 `dist/`、`build/`、`data/` 被排除）

**Approach:**
- `package.json` 声明 `"packageManager": "pnpm@10.32.1"`
- `dependencies`：`electrobun`、`surrealdb`、`@surrealdb/node`、`@mastra/core`
- `devDependencies`：`typescript`、`vite`、`@sveltejs/vite-plugin-svelte`、`svelte`、`@revolist/svelte-datagrid`、`bun-types`
- `scripts`：`dev`（并发运行 vite build --watch 和 electrobun dev --watch）、`build`、`start`
- 根 tsconfig target: `ES2022`，lib: `["ES2022"]`（无 DOM，主进程不需要）
- renderer tsconfig 额外 lib: `["ES2022", "DOM", "DOM.Iterable"]`

**Test scenarios:**
- Test expectation: none — 纯配置文件，无行为逻辑

**Verification:**
- `pnpm install` 成功，生成 `pnpm-lock.yaml`，无 `package-lock.json`
- `node_modules/.bin/electrobun` 符号链接存在

---

- [ ] **Unit 2: Electrobun 构建配置**

**Goal:** 建立 `electrobun.config.ts` 和 `vite.config.ts`，使构建流水线可运行

**Requirements:** R1, R4

**Dependencies:** Unit 1

**Files:**
- Create: `electrobun.config.ts`
- Create: `vite.config.ts`
- Create: `src/renderer/index.html`（WebView HTML 入口）

**Approach:**
- `electrobun.config.ts`：`app.identifier: "com.surreal.ck"`，`app.version` 从 package.json 读取
- `build.bun.entrypoint: "src/main/index.ts"`
- `build.views.mainview.entrypoint: "src/renderer/main.ts"`（Bun 也会 bundle renderer，但 Vite 产物优先）
- `build.copy`：将 `dist/` 内容映射到 `views/mainview/`（`dist/index.html` → `views/mainview/index.html`，`dist/assets` → `views/mainview/assets`）
- `build.mac.bundleCEF: false`（使用系统 WKWebView）
- `vite.config.ts`：`root: "src/renderer"`，output: `../../dist`，plugin: svelte with `runes: true`，target: `esnext`
- `concurrently` 用于 dev 脚本并发运行 Vite watch + Electrobun dev watch

**Test scenarios:**
- Test expectation: none — 构建配置，验证在 Unit 6 集成验证中覆盖

**Verification:**
- `pnpm run build` 完成，`dist/` 内有 `index.html` + `assets/`
- `build/dev-macos-arm64/` 内有 `.app` 且可启动

---

- [ ] **Unit 3: Bun 主进程入口 + SurrealDB 初始化**

**Goal:** 主进程启动时嵌入式 SurrealDB 初始化完成，schema/main.surql 加载成功

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Create: `src/main/index.ts`（主进程入口）
- Create: `src/main/db/index.ts`（DB 单例）
- Test: `src/main/db/index.test.ts`

**Approach:**
- `src/main/db/index.ts` 导出 `initDb()` async 函数和 `db` 单例
- 连接 URL：开发环境用 `surrealkv://./data/app.db`（永久存储），路径相对于 CWD
- 启动顺序严格遵守：`connect` → `signin` → `use` → `query(schema)`
- `schema/main.surql` 通过 `Bun.file("./schema/main.surql").text()` 读取
- `src/main/index.ts` 调用 `initDb()`，失败时 `console.error` 并 `process.exit(1)`
- 导出 `db` 供其他模块 import 使用（单例模式）

**Test scenarios:**
- Happy path: `initDb()` 返回已连接的 `Surreal` 实例，`db.query("SELECT 1")` 返回结果
- Error path: 无效连接 URL 时 `initDb()` 抛出错误
- Edge case: 重复调用 `initDb()` 不创建第二个连接（单例保护）

**Verification:**
- 主进程启动日志中出现"DB initialized"
- `data/app.db` 文件在首次运行后被创建

---

- [ ] **Unit 4: Mastra 初始化**

**Goal:** @mastra/core 在 Bun 主进程内可导入并初始化，无运行时错误

**Requirements:** R3

**Dependencies:** Unit 3

**Files:**
- Create: `src/main/ai/index.ts`

**Approach:**
- 创建 `Mastra` 实例（空配置，无 agent，无 tool），只验证可用
- `src/main/index.ts` 调用 `initMastra()`，失败时日志警告但不阻止启动（Mastra 不是关键路径）

**Test scenarios:**
- Happy path: `new Mastra({})` 不抛出错误，实例可被创建
- Integration: 主进程启动后日志出现"Mastra initialized"

**Verification:**
- `pnpm run dev` 启动后控制台无 Mastra 相关错误
- Mastra 实例可被后续 agent 注册代码 import

---

- [ ] **Unit 5: RPC 类型定义 + 主进程 RPC handlers**

**Goal:** 定义主进程与 WebView 之间的 RPC 类型契约，注册主进程侧 handlers

**Requirements:** R6

**Dependencies:** Unit 3

**Files:**
- Create: `src/shared/rpc.types.ts`
- Modify: `src/main/index.ts`（注册 RPC，创建 BrowserWindow）

**Approach:**
- `src/shared/rpc.types.ts` 定义 `AppRPC` 类型，包含：
  - `bun.requests.query`：接受 SurrealQL 字符串，返回查询结果（验证用）
  - `bun.messages.log`：WebView 发来的日志消息
  - `webview.messages.pushRows`：主进程向 WebView 推送行数据
- 主进程使用 `BrowserView.defineRPC<AppRPC>({ handlers: { ... } })` 注册
- `BrowserWindow` 的 `url: "views://mainview/index.html"`
- `dom-ready` 事件后向 WebView 推送一批测试数据（`pushRows`），验证单向通信

**Test scenarios:**
- Happy path: `bun.requests.query` handler 执行 `db.query()` 返回结果
- Integration: `dom-ready` 后 `pushRows` message 被 WebView 侧接收

**Verification:**
- 编译无类型错误
- 主进程侧 handler 可接收来自 WebView 的 request 并返回响应

---

- [ ] **Unit 6: Svelte 5 WebView — App 骨架 + RevoGrid 集成**

**Goal:** WebView 加载 Svelte 5 应用，RevoGrid 展示主进程 push 的测试数据，RPC 双向通信打通

**Requirements:** R4, R5, R6

**Dependencies:** Unit 2, Unit 5

**Files:**
- Create: `src/renderer/main.ts`（Svelte 挂载入口）
- Create: `src/renderer/App.svelte`（根组件）
- Create: `src/renderer/lib/rpc.ts`（WebView 侧 RPC 单例）
- Create: `src/renderer/features/grid/Grid.svelte`（RevoGrid 封装）

**Approach:**
- `src/renderer/lib/rpc.ts`：`Electroview.defineRPC<AppRPC>` 注册 WebView 侧 handlers，导出 `rpc` 单例
- `App.svelte`：`let rows = $state([])`，通过 `webview.messages.pushRows` handler 更新 `rows`
- `Grid.svelte`：接收 `rows` 和 `columns` props，渲染 `<RevoGrid>`
- 初始列定义为 3 列（id、name、value），对应主进程推送的测试数据结构
- `beforepasteapply` 事件 handler 打印 parsed TSV 到控制台（验证 Excel 粘贴链路）
- RPC 实例在模块顶层初始化（非 `$effect` 内），避免重复注册

**Test scenarios:**
- Happy path: 页面加载后 `rows` 被 `pushRows` 填充，RevoGrid 显示数据
- Integration: WebView 调用 `rpc.request.query("SELECT 1")` 收到主进程响应
- Happy path: 从 Excel 复制单元格粘贴到 RevoGrid，`beforepasteapply` 触发，parsed 数组正确
- Edge case: `rows` 更新时使用新数组引用（`rows = newRows`），不使用 push/mutation

**Verification:**
- 桌面窗口打开后可见 RevoGrid 表格，含测试数据
- 浏览器 DevTools Console 无错误
- 从 Excel 粘贴数据后控制台打印 parsed TSV

---

## System-Wide Impact

- **进程边界**：所有数据库操作在 Bun 主进程内，WebView 不直接接触 SurrealDB SDK
- **RPC 作为唯一通信通道**：WebView 无 HTTP 访问能力，无 localhost server，所有跨进程数据必须走 `AppRPC`
- **schema/main.surql 加载**：现有 schema 定义了 `DEFINE ACCESS madocs`（JWT OIDC），embedded 模式下 root signin 绕过 ACCESS，不冲突
- **Unchanged invariants**：`schema/` 目录不修改，`AGENTS.md` / `CLAUDE.md` 规则不变

## Risks & Dependencies

| 风险 | 缓解 |
|------|------|
| pnpm + Electrobun bin 解析失败 | `.npmrc` 设置 `shamefully-hoist=true`；验证 `node_modules/.bin/electrobun` 存在 |
| surrealdb-node NAPI 在 Bun 下行为差异 | 官方支持 Bun 1.x；Unit 3 有独立测试覆盖启动序列 |
| Vite build 产物路径与 electrobun.config copy 不匹配导致 WebView 白屏 | Unit 2 明确规定路径映射规则；dev 模式下立即可见白屏 |
| RevoGrid Svelte 5 适配层（Stencil 转接）的未知问题 | 版本锁定 `@revolist/svelte-datagrid@^4.11.0`；Unit 6 验证时若有问题可降级为原生 Web Component 用法 |
| concurrently 并发 dev 脚本竞态（Vite 未完成时 Electrobun 已加载旧 dist） | Electrobun dev --watch 会在文件变化时重载；接受首次启动可能需要手动重载 |

## Sources & References

- [Electrobun Build Configuration](https://blackboard.sh/electrobun/docs/apis/cli/build-configuration/)
- [Electrobun RPC API](https://blackboard.sh/electrobun/docs/apis/browser-view/)
- [surrealdb-node embedded](https://surrealdb.com/docs/sdk/javascript/engines/node)
- [RevoGrid Svelte Guide](https://rv-grid.com/guide/svelte/)
- [RevoGrid Clipboard](https://rv-grid.com/guide/clipboard)
- [Svelte 5 TypeScript](https://svelte.dev/docs/svelte/typescript)
