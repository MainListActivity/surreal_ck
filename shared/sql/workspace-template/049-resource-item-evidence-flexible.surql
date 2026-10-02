-- LCA14 返工修复：resource_item.evidence 是 SCHEMAFULL 表上的裸 array，
-- 引擎为其生成非 FLEXIBLE 的隐式 evidence.* 子定义，对象元素被整体拒绝
-- （POST /api/resources/research/save 在 persisting 阶段事务回滚）。
-- 008 原文件不改写——按增量约定补显式 FLEXIBLE 子定义：DEFINE 保证字段
-- 存在，ALTER 修复既有 workspace 上已生成的非 FLEXIBLE 隐式子定义。
-- 只加字段定义，不改写任何已有数据行。

DEFINE FIELD IF NOT EXISTS evidence.* ON TABLE resource_item TYPE object FLEXIBLE;
ALTER FIELD evidence.* ON TABLE resource_item FLEXIBLE;
