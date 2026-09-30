-- VER03：通用持久化触发表。虚拟员工 runtime 的领域中立触发队列——
-- 只描述"哪个员工因什么原因需要运行"，不携带办公室业务语义。
-- 触发由员工自己的 RECORD 会话写入并推进状态（root 无权限也无需介入）；
-- db 边界天然隔离 workspace，idempotency_key 唯一索引负责重复投递收敛。

DEFINE TABLE IF NOT EXISTS employee_trigger SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE employee = $auth,
    FOR delete WHERE $auth.is_admin = true;

DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE employee_trigger TYPE string;
DEFINE FIELD IF NOT EXISTS employee ON TABLE employee_trigger TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS reason ON TABLE employee_trigger TYPE string;
DEFINE FIELD IF NOT EXISTS payload_ref ON TABLE employee_trigger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS chain_depth ON TABLE employee_trigger TYPE int DEFAULT 0;
-- 状态机覆盖 leased/waiting（执行窗口 lease 与挂起由后续增量接管），本增量只用 pending/running/completed/failed。
DEFINE FIELD IF NOT EXISTS status ON TABLE employee_trigger TYPE string DEFAULT "pending"
  ASSERT $value INSIDE ["pending", "leased", "running", "waiting", "completed", "failed"];
DEFINE FIELD IF NOT EXISTS result ON TABLE employee_trigger TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS error_message ON TABLE employee_trigger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE employee_trigger TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE employee_trigger TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE employee_trigger TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS employee_trigger_idempotency_unique ON TABLE employee_trigger COLUMNS idempotency_key UNIQUE;
