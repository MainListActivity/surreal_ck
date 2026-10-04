-- 债权人申报 rate_segments：SCHEMAFULL 上 array<object> 会生成非 FLEXIBLE 的隐式
-- rate_segments.* 子定义，写入对象元素时报 Found field 'rate_segments[0].…'。
-- 与 049-resource-item-evidence-flexible 同模式：DEFINE 显式 FLEXIBLE 子定义，
-- ALTER 修复已有 workspace 上的隐式子定义。只新增/调整字段定义，不改写数据行。

DEFINE FIELD IF NOT EXISTS rate_segments.* ON TABLE claim_submission TYPE object FLEXIBLE;
ALTER FIELD rate_segments.* ON TABLE claim_submission FLEXIBLE;
