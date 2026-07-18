Status: done

## Parent

`.scratch/home-redesign/issues/07-activity-panel.md`

## What to build

让**记录级写入**（增 / 删 / 改数据行）也自动产生动态事件——覆盖"添加了 N 条记录"这类首页动态。

业务实体表是**动态建的**（`ent_<wbKey>_main`，建于新建工作簿的事务里），不在静态模板 schema 中，所以它们的 `DEFINE EVENT` 必须在**每次建表时一并定义**。本 issue 在建实体表的事务内追加一条 `DEFINE EVENT`，使该表的 CREATE / UPDATE / DELETE 自动 `CREATE activity_event`（`verb` = `record.write` / `record.delete`，归因走 `fn::current_user()`）。

这是 DDL，仍由 admin 会话执行（与建表同一条事务），符合权限模型——DDL 由 access 类型卡死，不在代码里手写 is_admin 守卫。

事件**逐行触发**（一次写 12 行 = 12 条 activity_event），不在单条事件里累加 count——"添加了 N 条记录"的聚合在 HR-16 的渲染层做。

> 已存在的老库实体表没有这个 event 属可接受（动态是新功能，从启用起记录）；如要为老表补 event，可在 migration 里遍历 `sheet.table_name` 追加，属可选增强，不在本 issue 必做范围。

> 写 SurrealQL 前先调用 `surrealql` skill。建表 SQL 的表名来自受控来源（randomKey），无注入面；event THEN 块用 `$event` / `$after` / `$before`。

## Acceptance criteria

- [x] 新建工作簿的建表事务内，为实体表追加 `DEFINE EVENT`，记录写入时自动 `CREATE activity_event`
- [x] 数据行 CREATE → `verb=record.write`；DELETE → `verb=record.delete`；归因 `fn::current_user()`
- [x] event 定义与建表 / 建 workbook / 建 sheet 在同一事务内（任一步失败整体回滚）
- [x] 新建工作簿后写入数据行，能 `SELECT * FROM activity_event` 查到对应事件
- [x] 相关纯逻辑测试（建表事务 SQL 含 event 定义）更新并全绿
- [x] svelte-check / tsc 无类型错误

## Blocked by

- HR-14 `activity_event` schema + 静态表 event
