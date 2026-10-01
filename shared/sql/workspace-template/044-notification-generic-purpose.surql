-- CV01/CV05：user_notification.purpose 默认桶通用化。
--
-- 031 引入 purpose 时把默认桶定为 "claims-risk"（当时唯一写入方是债权提醒任务）。
-- VO03 之后该表已是通用人类注意力通道，默认值不应再假设法律域：
--   - 债权提醒写入方（surreal-claims-risk-store.saveReminder）改为显式
--     purpose = "claims-risk"，不再依赖默认值；
--   - 缺省/未知用途归通用桶 "info"。
-- 枚举集合不动——"claims-risk" 仍是合法值，存量行与历史快照保持不变；
-- READONLY 断言与 041 逐字一致，仅 DEFAULT 变化。新写入方若不带 purpose
-- 将落到 "info"，不再被误归债权风险。

DEFINE FIELD OVERWRITE purpose ON TABLE user_notification TYPE option<string> DEFAULT "info" READONLY
  ASSERT $value = NONE OR $value INSIDE ["claims-risk", "office-request", "info"];
