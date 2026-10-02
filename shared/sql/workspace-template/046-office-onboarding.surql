-- VO06：onboarding 幂等门禁——初始办公室任务仅在数据导入完成或管理员明确
-- 跳过后才允许创建；import_state 持久化后刷新/重试收敛到同一决定，导入失败
-- 保留可重试状态而不是伪装成开岗成功。
--
-- 只追加字段：存量行读取为 NONE（视同 pending），无数据改写。

DEFINE FIELD IF NOT EXISTS import_state ON TABLE office_meta TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["imported", "skipped", "failed"];
