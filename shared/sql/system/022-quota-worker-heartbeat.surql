-- LCA 控制面修复：worker 环路持久化心跳（只新增结构）。
-- 每个环路固定一行（record id = 环路名），UPSERT 覆盖不累积；
-- 仅计数/时间/错误码，不含请求载荷与用户内容。
-- 用途：/health 的进程内 liveness 之外的持久事实源——ops/QA 可在
-- _system 直接读取最近推进时间，区分「HTTP 正常」与「worker 正常」。
DEFINE TABLE IF NOT EXISTS quota_worker_heartbeat SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS loop ON TABLE quota_worker_heartbeat TYPE string;
DEFINE FIELD IF NOT EXISTS worker_id ON TABLE quota_worker_heartbeat TYPE string;
DEFINE FIELD IF NOT EXISTS tick_count ON TABLE quota_worker_heartbeat TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS consecutive_errors ON TABLE quota_worker_heartbeat TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS timeouts ON TABLE quota_worker_heartbeat TYPE int
  DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS last_tick_at ON TABLE quota_worker_heartbeat TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_success_at ON TABLE quota_worker_heartbeat TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error_code ON TABLE quota_worker_heartbeat TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_error_at ON TABLE quota_worker_heartbeat TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE quota_worker_heartbeat TYPE datetime
  VALUE time::now();
