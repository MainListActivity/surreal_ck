Status: done
Label: done

# OIP-05 — 模板默认仪表盘实例化

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

允许模板包声明默认仪表盘页面和组件。声明使用数据表稳定 key 与结构化 widget spec；实例化时映射到本次创建的真实实体表，并创建现有 dashboard 页面数据。模板创建完成后用户能直接打开真实数据驱动的仪表盘，后续仍可用现有 builder 编辑或删除。

## Acceptance criteria

- [x] 模板包可以声明一个默认仪表盘页面及 KPI、图表或列表组件。
- [x] 实例化后 widget 查询只指向本工作簿的实体表，两个模板实例互不串数据。
- [x] 默认 widget 与手工 builder、AI 草稿持久化使用同一个 DashboardWidget 数据结构。
- [x] 仪表盘组件执行真实聚合查询，并随样例数据或后续用户数据变化。
- [x] 用户可以编辑、重新布局或删除默认组件和页面。
- [x] 仪表盘声明无效时模板创建整体失败，不留下部分工作簿。

## Delivered

- workspace 模板增量 015 为 `workbook_template` 增加 `default_dashboard` 结构化声明。
- 模板实例化器把 widget spec 中的数据表稳定 key 映射为本次工作簿的真实实体表，并把页面、组件、样例数据与结构放进同一事务。
- 默认组件复用既有 `DashboardWidget` / `DashboardBuilderSpec`；KPI、分类图和结构化列表均走浏览器直连真实查询。
- 实例化前校验页面、组件、布局、数据表、字段与查询结果契约；无效声明不执行事务。
- 真实 SurrealDB 集成测试覆盖实例隔离、数据变化、编辑布局、删除页面与失败回滚。

## Blocked by

- `.scratch/operating-iteration-plan/issues/04-template-sample-data.md`
