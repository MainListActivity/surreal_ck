-- VER04：可恢复执行窗口与幂等副作用。
--
-- employee_trigger 增 lease 语义：执行窗口先把触发置为 leased 并写下
-- lease_expires_at / attempts / run_id，进程消失后下一个 runtime 按
-- lease 过期时间回收（active run 走 Mastra restart 语义）；waiting 是
-- 显式 suspend 的观察态，只经 resume 语义离开。
-- 不加字段级业务约束——状态转移全部在 runtime 的原子 UPDATE 里表达。
--
-- employee_effect 是有副作用动作的幂等账本：稳定 effect_key 唯一索引
-- 兜底"重复认领不产生重复副作用"；pending → committed 两段式记录覆盖
-- "效果已提交、snapshot 未更新"之间的崩溃窗口——重启读到 committed 行
-- 直接回既有结果，不重复写入。trigger 记录归属同一 workspace database，
-- 全部经员工自己的 RECORD 会话写入（与 employee_trigger 同权限形状）。

DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE employee_trigger TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS attempts ON TABLE employee_trigger TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS run_id ON TABLE employee_trigger TYPE option<string>;
-- 回收扫描：按 (status, lease_expires_at) 找过期 lease 的触发。
DEFINE INDEX IF NOT EXISTS employee_trigger_lease_scan ON TABLE employee_trigger COLUMNS status, lease_expires_at;
DEFINE INDEX IF NOT EXISTS employee_trigger_run ON TABLE employee_trigger COLUMNS run_id;

DEFINE TABLE IF NOT EXISTS employee_effect SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE employee = $auth,
    FOR delete WHERE $auth.is_admin = true;

DEFINE FIELD IF NOT EXISTS effect_key ON TABLE employee_effect TYPE string
  ASSERT $value != "" AND string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS employee ON TABLE employee_effect TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS trigger ON TABLE employee_effect TYPE option<record<employee_trigger>>;
DEFINE FIELD IF NOT EXISTS status ON TABLE employee_effect TYPE string DEFAULT "pending"
  ASSERT $value INSIDE ["pending", "committed"];
DEFINE FIELD IF NOT EXISTS result ON TABLE employee_effect TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE employee_effect TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE employee_effect TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS employee_effect_key_unique ON TABLE employee_effect COLUMNS effect_key UNIQUE;

-- employee_window：每员工至多一个活跃执行窗口的进程间互斥行。employee 唯一
-- 索引兜底 INSERT 原子性；持有方写 holder/lease_expires_at，租约到期才可被
-- 条件 ON DUPLICATE 夺走——进程消失不会永久占住窗口。窗口内触发的租约走
-- employee_trigger.lease_expires_at，与本行是同一把锁的两层投影（本行是
-- "员工在跑"，触发行是"哪条触发在跑"）。
DEFINE TABLE IF NOT EXISTS employee_window SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.kind = "virtual",
    FOR update WHERE employee = $auth,
    FOR delete WHERE $auth.is_admin = true;

DEFINE FIELD IF NOT EXISTS employee ON TABLE employee_window TYPE record<user> DEFAULT fn::current_user();
DEFINE FIELD IF NOT EXISTS holder ON TABLE employee_window TYPE option<string>;
DEFINE FIELD IF NOT EXISTS trigger ON TABLE employee_window TYPE option<record<employee_trigger>>;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON TABLE employee_window TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE employee_window TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE employee_window TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS employee_window_employee_unique ON TABLE employee_window COLUMNS employee UNIQUE;
