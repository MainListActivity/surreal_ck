-- PG-1 停滞防护：chat_delivery 增加 run 终态操作诊断快照字段。
-- 存脱敏操作流水（阶段/工具名/参数键形状/稳定错误码/时长），供停滞 run 事后归因；
-- 不落 SQL 文本、变量值、行数据、token 或业务值。
-- 只新增兼容字段，不改写任何已有数据行。

DEFINE FIELD IF NOT EXISTS run_diagnostic ON TABLE chat_delivery TYPE option<object> FLEXIBLE;
