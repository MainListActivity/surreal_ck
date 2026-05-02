---
title: SurrealDB Optional Field Writes Must Use NONE Semantics Instead of NULL
date: 2026-05-02
category: database-issues
module: surrealdb
problem_type: database_issue
component: database
symptoms:
  - Optional fields were being written as NULL instead of being omitted or cleared.
  - Clearing optional fields through update and merge paths did not remove the field.
  - Writes to option<T> or T | NONE fields could fail or produce invalid semantics.
  - token_store writes followed the same broken null-handling pattern.
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - authentication
  - tooling
tags:
  - surrealdb
  - null
  - none
  - undefined
  - option
  - typescript
  - token-store
  - value-mapping
---

# SurrealDB Optional Field Writes Must Use NONE Semantics Instead of NULL

## Problem
仓库里多处把 JavaScript `null` 直接传给 SurrealDB，导致“未填写字段”和“显式清空字段”被错误地统一成了 `NULL`。对本项目大量使用的 `option<T>` / `T | NONE` 字段来说，这既不符合 schema 合同，也会让 create、update、merge 三类写入的语义错位。

## Symptoms
- `create` / `insert` / `CONTENT` 路径会把未填写的可选字段写成 `NULL`，而不是省略字段。
- `update` / `SET` / `MERGE` 路径想清空字段时，数据库收到的是 `NULL`，不是 `NONE`。
- `option<T>` / `T | NONE` 字段会出现类型错误，或留下“字段存在但值为 NULL”的错误状态。
- `token_store` 的 `refresh_token` 持久化也使用了同样的空值写法。

## What Didn't Work
- 直接把 DTO、表单对象或 patch 对象原样传给 SurrealDB。这样会保留 JS `null`，让 SurrealDB 落成 `NULL`。
- 把“未填写”和“清空字段”都抽象成 `null`。在 JS/TS 层看起来简单，但在 SurrealDB 里这是两个不同语义。
- 在个别调用点临时写 `?? undefined`。这种修法只能补单点，不能形成全仓统一规则。

## Solution
这次修复把 SurrealDB 写库分成两类语义，并抽出统一 helper 到 [src/main/db/surreal-values.ts](/Users/y/IdeaProjects/surreal_ck/src/main/db/surreal-values.ts)：

- `omitNullishSurrealFields()`：给 `create` / `insert` / `CONTENT`
- `mapNullToSurrealNone()`：给单字段 `SET`
- `mapNullsToSurrealNone()`：给对象型 `MERGE`

关键改动：

- [src/main/services/editor.ts](/Users/y/IdeaProjects/surreal_ck/src/main/services/editor.ts)
  - create 前省略 `null` / `undefined`
  - merge 前把 `null` 转成 `undefined`
- [src/main/services/workbooks.ts](/Users/y/IdeaProjects/surreal_ck/src/main/services/workbooks.ts)
  - 清空 `folder` 时传 `undefined`
- [src/main/services/folders.ts](/Users/y/IdeaProjects/surreal_ck/src/main/services/folders.ts)
  - 清空 `parent` 时传 `undefined`
- [src/main/db/index.ts](/Users/y/IdeaProjects/surreal_ck/src/main/db/index.ts)
  - `token_store` 改成 `UPSERT ... CONTENT $content`
- [src/main/auth/session.ts](/Users/y/IdeaProjects/surreal_ck/src/main/auth/session.ts)
  - 刷新 token 后同样改成 `CONTENT $content`

Before:

```ts
await db.query(
  `UPSERT token_store:local CONTENT {
    access_token: $access_token,
    refresh_token: $refresh_token,
    expires_at: $expires_at
  }`,
  {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: new DateTime(new Date(...)),
  }
);
```

After:

```ts
await db.query(`UPSERT token_store:local CONTENT $content`, {
  content: omitNullishSurrealFields({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new DateTime(new Date(...)),
  }),
});
```

Before:

```ts
const updateValues = { ...cleanValues, updated_at: new Date() };
await db.query(`UPDATE $rowId MERGE $vals`, { rowId, vals: updateValues });
```

After:

```ts
const updateValues = mapNullsToSurrealNone({
  ...cleanValues,
  updated_at: new Date(),
});
await db.query(`UPDATE $rowId MERGE $vals`, { rowId, vals: updateValues });
```

同时新增测试 [src/main/db/surreal-values.test.ts](/Users/y/IdeaProjects/surreal_ck/src/main/db/surreal-values.test.ts) 来锁住这套映射约定。`pnpm test` 通过，37 个测试全绿。

## Why This Works
这次修复生效的根本原因，是代码终于对齐了 SurrealDB 的实际值语义：

- JS `null` 会变成 Surreal `NULL`
- JS `undefined` 会变成 Surreal `NONE` / 字段移除
- `option<T>` 或 `T | NONE` 接受的是“有值”或 `NONE`，不是 `NULL`

因此两类写入必须分开处理：

- `create` / `insert` / `CONTENT`：未填写字段应直接省略
- `update` / `SET` / `MERGE`：显式清空字段应转换成 `undefined`

如果继续把 `null` 当作统一的“空值表达”，就会把 schema 约束、业务语义和 SDK 映射全部混在一起。

## Prevention
- 只要是 SurrealDB 写入，先判断这是 `create/content` 还是 `update/merge/set`，再决定用哪套 helper。
- 不要再把 JS `null` 直接传给 SurrealDB，尤其是可选字段、关系字段、token 持久化字段。
- 代码评审时重点检查这几类模式：

```ts
await db.create("table", { optionalField: null });
await db.merge(id, { optionalField: null });
await db.query("UPDATE table SET optionalField = $value", { value: null });
```

- 应改成：

```ts
await db.create("table", omitNullishSurrealFields({
  optionalField: maybeValue,
}));

await db.merge(id, mapNullsToSurrealNone({
  optionalField: maybeValue ?? null,
}));
```

- 对新 helper 至少保留这两类测试：
  - `omitNullishSurrealFields({ a: 1, b: null, c: undefined })` 只保留 `a`
  - `mapNullsToSurrealNone({ a: 1, b: null })` 中 `b` 必须变成 `undefined`

## Related Issues
- [surrealdb-embedded-local-first-session-isolation-2026-04-25.md](/Users/y/IdeaProjects/surreal_ck/docs/solutions/best-practices/surrealdb-embedded-local-first-session-isolation-2026-04-25.md) 同属 SurrealDB SDK / embedded 使用约定，但它的 `token_store` 示例需要按这次规则刷新。
