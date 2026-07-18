Status: done

## Parent

`.scratch/home-redesign/issues/07-activity-panel.md`（HR-07 交付了 ActivityPanel 三 tab 外壳，动态/趋势用 mock；本 issue 落地真实动态数据底座）

## What to build

新增 workspace database 模板增量，落地 `activity_event` 表——首页「动态」的真实数据来源。

动态事件**由 SurrealDB 引擎层 `DEFINE EVENT` 自动写入，前端零埋点**：当用户对业务表做写操作时，event 触发并 `CREATE activity_event`。本 issue 负责表本身 + workbook / sheet / dashboard_page 三张静态业务表上的 event。记录级实体表的 event 在 HR-15 处理（建表是动态 DDL）。

`activity_event` 表归属 workspace database（跨 workspace 隔离靠 db 边界，**不带 workspace 字段**，PERMISSIONS 只表达本 workspace 内角色）：

- 归因走 `fn::current_user()`（009 已支持 admin JWT / participant / employee 三种会话身份；admin 会话 `$auth` 为 NONE 时按 `$token.sub` 反查），不手工标 `from_*`。
- `verb` 用枚举 ASSERT 约束（如 `workbook.create` / `workbook.rename` / `field.define` / `field.remove` / `record.write` / `record.delete` 等），便于前端映射中文文案。
- PERMISSIONS：`FOR select WHERE $auth != NONE`（同 workspace 任何登录用户可见）；`FOR create WHERE $auth != NONE`（普通成员的写操作也要能落动态）；`FOR update, delete WHERE $auth.is_admin = true`。
- `created_at` 带索引，供动态列表 `ORDER BY created_at DESC` 与 HR-17 趋势聚合使用。

静态表 event 在 event THEN 块内用 `$event` / `$after` / `$before` 拼出对应 `activity_event` 行（参考 005 的 cleanup event 写法 + 009 的 `fn::current_user()`）。

> 写 SurrealQL 前先调用 `surrealql` skill；schema 用 `surreal validate` 校验。增量文件追加到 `shared/sql/workspace-template/`，文件名带版本号 `010-`，并同步更新 `index.ts` 的 `TEMPLATE_FILES`（version=10）与 `index.test.ts` 断言。已有库靠 migration-runner 自动追加。

## Acceptance criteria

- [x] `shared/sql/workspace-template/010-*.surql` 定义 `activity_event` 表，SCHEMAFULL，归属 db 边界（无 workspace 字段）
- [x] `actor` 字段 `DEFAULT fn::current_user()`，类型 `option<record<user>>`
- [x] `verb` 用 `ASSERT $value INSIDE [...]` 枚举约束，覆盖 workbook / field / record 写入动词
- [x] `created_at` 带索引；PERMISSIONS 为「select/create: $auth != NONE，update/delete: is_admin」
- [x] workbook / sheet / dashboard_page 三张静态表各有 `DEFINE EVENT`，写入时自动 `CREATE activity_event`
- [x] workspace template 加载器自动发现版本 10 增量，无需维护手工文件清单
- [x] `index.test.ts` 覆盖增量自动发现与 `activity_event` schema，shared 测试全绿
- [x] `surreal validate` 通过

## Blocked by

None — can start immediately
