-- VO02：任务的显式完成条件与创建期工作指令。
--
-- 全部为可选字段，追加定义对存量行与既有写入零影响：
-- - completion：任务创建时声明的可判定完成条件（独立于 goal 的执行出口）；
-- - brief：创建期一次性指令（派单目标、DDL 尝试等），READONLY 与
--   assigner/assignee/parent/depth 同级不可改写，运行时只能读取不能修订。

DEFINE FIELD IF NOT EXISTS completion ON TABLE office_task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS brief ON TABLE office_task TYPE option<object> FLEXIBLE READONLY;
