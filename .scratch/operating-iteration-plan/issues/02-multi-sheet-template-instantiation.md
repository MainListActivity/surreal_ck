Status: done
Label: done

# OIP-02 — 多数据表模板原子实例化

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

让一个模板包可以声明多个彼此独立的数据表。用户从模板创建工作簿时，浏览器使用当前管理员会话预生成全部实体表和记录标识，并在一个事务中创建实体表、工作簿及多条数据表元数据；成功后编辑器立即显示全部数据表。

本切片只处理彼此独立的数据表，不处理数据表之间的引用和样例记录。

## Acceptance criteria

- [x] 模板包包含两个或更多数据表时，每个定义都生成独立实体表和数据表元数据。
- [x] 创建成功后编辑器导航显示全部数据表，并能在它们之间切换和读写记录。
- [x] 任一实体表或元数据创建失败时整个事务回滚，不留下半成品工作簿。
- [x] 工作簿保留模板引用，首页卡片继续从模板包解析展示信息。
- [x] DDL 使用浏览器当前管理员会话直连执行，不新增后端业务 CRUD endpoint。
- [x] 测试覆盖双数据表成功、事务失败回滚以及旧单数据表模板回归。

## Delivered

- 模板页将全部 `sheet_defs` 转为实例化输入，不再只取首表。
- 浏览器预生成 workbook / sheet RecordId 与独立实体表名，在单条 SurrealQL 事务内完成 DDL 和元数据创建。
- 旧顶层 `column_defs` 模板仍使用单表 `_main` 命名与旧创建语义。
- 真实 SurrealDB 集成测试覆盖双表编辑器读写、末段冲突全量回滚和旧单表回归。

## Blocked by

- `.scratch/operating-iteration-plan/issues/01-template-package-single-sheet-compat.md`
