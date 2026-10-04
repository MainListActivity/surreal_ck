-- 11.1 利息快照 segments：053 在 SCHEMAFULL 上定义 array<object> 时引擎已生成
-- 非 FLEXIBLE 的隐式 segments.* 子定义，053 内 IF NOT EXISTS 的显式定义被跳过，
-- 写入对象元素报 Found field 'segments[0].…'（049/052 同类）。
-- 本增量只调整字段定义：DEFINE 保证显式定义存在，ALTER 把已有 workspace 上的
-- 隐式非 FLEXIBLE 子定义改为 FLEXIBLE。不改写任何已有数据行。

DEFINE FIELD IF NOT EXISTS segments.* ON TABLE interest_calculation TYPE object FLEXIBLE;
ALTER FIELD segments.* ON TABLE interest_calculation FLEXIBLE;
