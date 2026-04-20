---
title: "Electrobun + @surrealdb/node IPC 架构迁移：六个集成陷阱与修复"
date: 2026-04-17
category: integration-issues
module: surreal_ck/infrastructure
problem_type: integration_issue
component: tooling
severity: critical
symptoms:
  - "Electrobun RPC schema 键名错误（myBunMethods/myViewMethods 不存在），导致 IPC 方法注册失败"
  - "surrealdb v2 SDK API 变化：db.merge() 已移除，db.create(Table).content(data) 为链式调用"
  - "@surrealdb/node 误作 default export 导入，实际需要 createNodeEngines() 插件注入"
  - "live() 返回 ManagedLivePromise 而非直接接受 callback，LIVE SELECT 订阅静默失败"
  - "TypeScript tsconfig.bun.json 无法解析 bun-types（pnpm 不提升 devDependency）"
  - "macOS sed 不支持 \\b 字边界，批量替换静默失败，文件内容未变更但无任何错误提示"
  - "ElectrobunConfig 顶层写了 bun/views 键，实际需嵌套在 build 下"
root_cause: wrong_api
resolution_type: migration
related_components:
  - database
  - authentication
  - development_workflow
tags:
  - electrobun
  - surrealdb-v2
  - surrealdb-node
  - ipc
  - local-first
  - desktop
  - live-select
  - architecture-migration
  - pnpm
  - macos
  - bun
  - surrealkv
---

# Electrobun + @surrealdb/node IPC 架构迁移：六个集成陷阱与修复

## Problem

将 surreal_ck 从"浏览器直连 SurrealDB WebSocket + OIDC 认证"迁移到"Electrobun 本地优先桌面应用（Bun 主进程嵌入 surrealdb-node + surrealkv，WebView 纯 IPC 通信）"时，六个第三方库的 API 假设全部需要纠正，导致编译期和运行期错误横跨整个栈。

## Symptoms

- `Module '"@surrealdb/node"' has no default export` — 错误地尝试 `import Surreal from "@surrealdb/node"`
- IPC 调用静默无响应 — Electrobun RPC schema 使用了不存在的 `myBunMethods`/`myViewMethods` 键
- `TypeError: db.merge is not a function` — surrealdb v2 移除了直接 merge 方法
- `db.live(table, callback)` 无效 — v2 的 `live()` 不接受 callback 参数
- `error TS2688: Cannot find type definition file for 'bun-types'` — pnpm 不提升 devDependency 到顶层 node_modules
- `error TS2351: This expression is not constructable` on `new BuildConfig({...})` — `BuildConfig` 是工具对象非构造函数
- `bun/views` 键 `does not exist in type 'ElectrobunConfig'` — 配置需嵌套在 `build` 下
- 批量 sed 替换后仍报 `Cannot find name 'Surreal'` — macOS sed 的 `\b` 静默失败

## What Didn't Work

- **`import Surreal from "@surrealdb/node"`**：`@surrealdb/node` 只导出 `NodeEngine` 和 `createNodeEngines`，不提供 `Surreal` 类。`Surreal` 类来自 `surrealdb` 主包（peer dependency）。
- **`RPCSchema<{ myBunMethods: {...}, myViewMethods: {...} }>`**：electrobun 文档模板中的 `myBunMethods`/`myViewMethods` 是占位名，实际 schema 接口要求 `requests` 和 `messages` 作为键名；顶层结构是 `{ bun: RPCSchema<...>, webview: RPCSchema<...> }`。
- **`db.merge(recordId, data)`（v1 API）**：surrealdb v2 中此方法签名已完全移除，`merge` 变成了 `update(recordId)` 返回对象上的链式方法。
- **`db.live(table, (action, result) => {...})`**：v2 的 `live()` 返回 `ManagedLivePromise`，需要 await 后再调用 `.subscribe(handler)`。
- **`sed -i '' 's/\bSurreal\b/DbAdapter/g' file`（macOS）**：macOS 的 BSD `sed` 不支持 Perl 风格的 `\b` 字边界，静默失败（退出码 0，文件未修改，无任何提示）。
- **`"types": ["bun-types"]` without typeRoots**：pnpm 默认不将 devDependency 提升到 `node_modules` 根目录，TypeScript 按默认路径找不到 `bun-types`。
- **顶层 `bun: { entrypoint: ... }`**：`ElectrobunConfig` 中 `bun` 和 `views` 的构建配置嵌套在 `build` 字段下，不在顶层。

## Solution

### 1. Electrobun RPC Schema：正确的双侧结构

```typescript
// bun/rpc-schema.ts
import { type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";

export type AppRPCSchema = ElectrobunRPCSchema & {
  bun: RPCSchema<{
    requests: {
      dbQuery: { params: { sql: string; vars?: Record<string, unknown> }; response: unknown };
      dbCreate: { params: { table: string; data: Record<string, unknown> }; response: Record<string, unknown> };
      dbMerge: { params: { recordId: string; data: Record<string, unknown> }; response: Record<string, unknown> };
      dbDelete: { params: { recordId: string }; response: void };
      dbUpsert: { params: { table: string; data: Record<string, unknown> }; response: Record<string, unknown> };
      getLocalUser: { params: Record<string, never>; response: { id: string; name: string } };
    };
    messages: Record<never, unknown>;
  }>;
  webview: RPCSchema<{
    requests: Record<never, unknown>;
    messages: {
      onChangefeed: { table: string; action: "CREATE" | "UPDATE" | "DELETE"; id: string; record: Record<string, unknown> | null };
      onSyncStatus: { status: "idle" | "syncing" | "error"; detail?: string };
    };
  }>;
};
```

**Bun 主进程侧（接受 webview requests，发送 webview messages）：**

```typescript
// bun/main.ts
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { AppRPCSchema } from "./rpc-schema";

// handlers 对象需要 any 断言以绕过 RPCRequestHandlerObject 的 index signature 限制
const requestHandlers: any = {
  dbQuery: (params: { sql: string; vars?: Record<string, unknown> }) => dbQuery(params.sql, params.vars),
  // ...其他 handlers
};

const rpc = BrowserView.defineRPC<AppRPCSchema>({
  handlers: { requests: requestHandlers },
});

// 向 webview 推送 CHANGEFEED 变更
rpc.send.onChangefeed({ table, action, id, record });
```

**WebView 侧（接受 bun messages，发送 bun requests）：**

```typescript
// views/main/ipc.ts
import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../../bun/rpc-schema";

const rpc = Electroview.defineRPC<AppRPCSchema>({
  handlers: {
    messages: {
      onChangefeed(payload) { /* 分发到订阅者 */ },
      onSyncStatus(payload) { /* 更新状态 */ },
    },
  },
});

const view = new Electroview({ rpc });

// 调用 bun 侧方法（request-response）
async function dbQuery<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
  return view.rpc!.request.dbQuery({ sql, vars }) as Promise<T>;
}
```

**关键规则**：`defineElectrobunRPC("bun", ...)` 的 `LocalSchema` = `{ requests: Schema["bun"]["requests"], messages: Schema["webview"]["messages"] }`，因此 bun 侧的 `rpc.send` 发送的是 `Schema["webview"]["messages"]` 类型的消息，即推给 webview。

---

### 2. @surrealdb/node：作为 Engine 插件注入

```bash
pnpm add surrealdb@2.0.3        # 主包（提供 Surreal 类、RecordId、Table 等）
pnpm add @surrealdb/node        # Engine 插件（嵌入式引擎，peer dep 需要 surrealdb@2）
```

```typescript
// bun/db.ts
import { Surreal, RecordId, Table } from "surrealdb";      // ← 主包
import { createNodeEngines } from "@surrealdb/node";       // ← 仅引擎

const db = new Surreal({ engines: createNodeEngines() });
await db.connect("surrealkv:///Users/username/Library/Application Support/MyApp/data");
await db.use({ namespace: "main", database: "app" });
```

---

### 3. surrealdb v2 链式 API

```typescript
// merge → update(RecordId).merge(data)
const result = await db.update(new RecordId("workspace", id)).merge({ name: "new name" });

// create(Table).content(data)
const result = await db.create(new Table("workbook")).content({ name: "My Workbook" });

// upsert(Table).content(data)
const result = await db.upsert(new Table("app_config")).content({ id: "device", deviceId: uuid });

// live subscription：await → subscribe → kill
const sub = await db.live(new Table("sheet"));
const unsub = sub.subscribe((msg: LiveMessage) => {
  const { action, recordId, value } = msg;
  handler(action, recordId.toString(), value as Record<string, unknown>);
});
await sub.kill();  // 取消时

// query 直接 await 返回结果数组
const results = await db.query<[WorkbookRow[]]>("SELECT * FROM workbook WHERE active = true");
const rows = results[0];  // 第一个语句的结果
```

---

### 4. ElectrobunConfig 正确结构

```typescript
// electrobun.config.ts
import type { ElectrobunConfig } from "electrobun/bun";

const config: ElectrobunConfig = {
  app: {
    name: "SurrealCK",
    identifier: "com.surreal.ck",
    version: "0.1.0",
  },
  build: {                            // ← bun/views 必须嵌套在 build 下
    bun: {
      entrypoint: "./bun/main.ts",
    },
    views: {
      main: {
        entrypoint: "./views/main/index.ts",
      },
    },
  },
};

export default config;
```

`BuildConfig`（来自 `electrobun/bun`）是读取运行时 `build.json` 的工具对象，不是用于手写配置的构造函数。

---

### 5. pnpm + bun-types：显式 typeRoots

```jsonc
// tsconfig.bun.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "typeRoots": [
      "node_modules/.pnpm/bun-types@1.3.12/node_modules",   // ← 版本号与 pnpm-lock.yaml 一致
      "node_modules/@types"
    ],
    "types": ["bun-types"]
  },
  "include": ["bun/**/*.ts"]
}
```

---

### 6. macOS 批量替换标识符：perl 而非 sed

```bash
# ✗ macOS BSD sed —— \b 不支持，静默失败，无任何输出或报错
sed -i '' 's/\bSurreal\b/DbAdapter/g' src/features/my-docs/folder-mutations.ts

# ✓ perl —— 支持 \b 字边界，正确替换
perl -pi -e 's/\bSurreal\b/DbAdapter/g' src/features/my-docs/folder-mutations.ts

# 批量处理多文件
FILES=(src/features/**/*.ts src/admin/*.tsx)
for f in "${FILES[@]}"; do
  perl -pi -e 's/\bSurreal\b/DbAdapter/g' "$f"
done
```

---

### 7. electrobun 内部依赖 three.js 的类型声明补丁

electrobun 导出的 `.ts` 文件（不是 `.d.ts`）引用了 `three`，但 `three` 未包含类型声明。`skipLibCheck: true` 只跳过 `.d.ts` 文件，不跳过 `.ts` 源文件。在 bun 代码目录添加一个声明文件：

```typescript
// bun/vendor.d.ts
declare module "three" {
  const value: unknown;
  export default value;
  export * from "three";
}
```

## Why This Works

**Electrobun RPC schema**：`defineElectrobunRPC` 在 bun 侧创建的 `LocalSchema = { requests: Schema["bun"]["requests"], messages: Schema["webview"]["messages"] }`。只有用正确的键名（`requests`/`messages`）才能被框架识别并绑定传输层。`myBunMethods`/`myViewMethods` 不是任何已知键，框架无法路由，调用静默失败。

**@surrealdb/node 插件模型**：`@surrealdb/node` 编译了 SurrealDB 的 WASM/native 引擎，但不提供 client API。`surrealdb` 主包提供完整的 TypeScript client（`Surreal` 类、ORM 方法、类型系统）。两个包分工明确：主包负责 API 层，`@surrealdb/node` 负责注册本地引擎到 `Surreal` 的 engines map。

**surrealdb v2 设计意图**：v2 采用 builder 模式，支持链式追加 `.content()`、`.where()`、`.output()` 等修饰符后再执行。`update(recordId).merge(data)` 明确表达"部分更新（patch）语义"，区别于 `update(recordId).content(data)`（全量替换）。直接方法（v1 style）被移除。

**pnpm 隔离**：pnpm 将每个包存在 content-addressable 存储中，只有显式依赖会被软链接到当前包的 `node_modules`，不提升全局路径。TypeScript 的默认 typeRoots 是 `node_modules/@types`，找不到 pnpm 隔离的 devDependency。显式的 `typeRoots` 指向带版本号的 pnpm 路径可绕过这个限制。

**macOS sed**：macOS 内置的是 BSD sed，而 Linux 上是 GNU sed。GNU sed 支持 `\b` 字边界；BSD sed 遇到 `\b` 时将其解释为退格字符，替换永远不命中，但不报错。Perl 内置 PCRE，`\b` 在所有平台上均一致工作。

## Prevention

- **创建 Electrobun 项目时**：从 `ElectrobunRPCSchema` 类型开始，用 TypeScript 的类型错误驱动开发，而非从模板拷贝键名
- **引入 @surrealdb/* 包时**：区分"引擎包"（`@surrealdb/node`、`@surrealdb/wasm`）和"客户端包"（`surrealdb`），引擎包永远是 peer dependency 的 plugin，不能替代客户端包
- **升级 surrealdb 大版本时**：v1→v2 的 API 变化涉及所有写操作（create/update/upsert/merge）和 live query，升级前对照 [v2 changelog](https://github.com/surrealdb/surrealdb.js) 逐一检查
- **pnpm workspace 中配置类型**：`bun-types`、`@types/bun` 等 devDependency 需要检查是否提升；用 `typeRoots` 显式配置路径，并在 CI 中锁定版本号
- **macOS 批量文本替换**：始终用 `perl -pi -e` 替代 `sed -i ''`；在第一次替换后 `grep -rn OldName src/ | wc -l` 验证是否为 0
- **ElectrobunConfig**：用 `import type { ElectrobunConfig } from "electrobun/bun"` 开启类型检查，TypeScript 会立即标出错误键名

## Related Issues

- [`docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md`](../best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md) — CHANGEFEED 所监听的 snapshot/entity 表 schema 设计，迁移后仍适用
