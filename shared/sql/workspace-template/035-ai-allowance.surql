-- LCA05 工作区共享 AI 额度闭环：版本化费率卡、独立额度桶、原子预留、结算/释放、
-- 失联回收与阈值提示。账本全部表成员可读、仅 root 可写（成员会话不能伪造余额、
-- 预留或冲销）；服务端门禁经 root 会话落账，actor 由调用者身份解析后绑定。
-- 每 workspace 一个 database：额度天然按工作区隔离，不按成员分配。

-- ── 计量动作费率卡：不可变 revision；先种子一个明确标注的测试修订 ──────────
DEFINE TABLE IF NOT EXISTS ai_rate_card SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS action_key ON TABLE ai_rate_card TYPE string;
DEFINE FIELD IF NOT EXISTS revision ON TABLE ai_rate_card TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS revision_label ON TABLE ai_rate_card TYPE string;
DEFINE FIELD IF NOT EXISTS amount ON TABLE ai_rate_card TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS tier_label ON TABLE ai_rate_card TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE ai_rate_card TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "retired"];
DEFINE FIELD IF NOT EXISTS published_at ON TABLE ai_rate_card TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS ai_rate_card_revision_unique
  ON TABLE ai_rate_card COLUMNS action_key, revision UNIQUE;
-- revision 内容不可变；允许 ODKDU 幂等重放里的 no-op update（$after == $before 放行）。
DEFINE EVENT OVERWRITE ai_rate_card_immutable ON TABLE ai_rate_card
  WHEN $event = "DELETE" OR ($event = "UPDATE" AND $after != $before)
  THEN { THROW "immutable-control-plane-record:ai_rate_card"; };

-- 测试费率修订：发布门禁要求的目录条目，数值是测试版本而非生产定价。
INSERT INTO ai_rate_card [
  {
    id: ai_rate_card:research_test_v1,
    action_key: "research",
    revision: 1,
    revision_label: "test-rate-v1",
    amount: 5,
    tier_label: "快速 AI 回答（测试费率）",
    status: "active"
  }
] ON DUPLICATE KEY UPDATE status = status;

-- ── 额度桶：套餐周期 / 购买加量 / 人工补偿独立成桶 ───────────────────────────
-- 消费顺序由服务端按 expires_at ASC → kind 优先级（套餐/补偿先于购买）→ created_at ASC
-- 逐桶条件扣减；suspended 桶不参与预留。expires_at 到期后由时间推导为已过期余额。
DEFINE TABLE IF NOT EXISTS ai_allowance_bucket SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS kind ON TABLE ai_allowance_bucket TYPE string
  ASSERT $value INSIDE ["plan_cycle", "purchased", "compensation"];
DEFINE FIELD IF NOT EXISTS label ON TABLE ai_allowance_bucket TYPE string;
DEFINE FIELD IF NOT EXISTS source ON TABLE ai_allowance_bucket TYPE option<string>;
DEFINE FIELD IF NOT EXISTS period_key ON TABLE ai_allowance_bucket TYPE string;
DEFINE FIELD IF NOT EXISTS total ON TABLE ai_allowance_bucket TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS available ON TABLE ai_allowance_bucket TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS reserved ON TABLE ai_allowance_bucket TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS settled ON TABLE ai_allowance_bucket TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS status ON TABLE ai_allowance_bucket TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "suspended"];
DEFINE FIELD IF NOT EXISTS effective_from ON TABLE ai_allowance_bucket TYPE datetime;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE ai_allowance_bucket TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ai_allowance_bucket TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ai_allowance_bucket TYPE datetime VALUE time::now();

-- ── 预留：绑定 actor / channel / 动作 / 费率修订 / 桶与幂等键 ─────────────────
DEFINE TABLE IF NOT EXISTS ai_reservation SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS actor ON TABLE ai_reservation TYPE record<user> READONLY;
DEFINE FIELD IF NOT EXISTS channel ON TABLE ai_reservation TYPE string READONLY
  ASSERT $value INSIDE ["interactive", "employee", "api_mcp", "batch"];
DEFINE FIELD IF NOT EXISTS action_key ON TABLE ai_reservation TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS rate ON TABLE ai_reservation TYPE record<ai_rate_card> READONLY;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE ai_reservation TYPE string READONLY;
-- run_id 让 suspend 后的 resume 能找回同一预留；不唯一（resume 不新建预留）。
DEFINE FIELD IF NOT EXISTS run_id ON TABLE ai_reservation TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS bucket ON TABLE ai_reservation TYPE record<ai_allowance_bucket> READONLY;
DEFINE FIELD IF NOT EXISTS max_amount ON TABLE ai_reservation TYPE int READONLY ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS settled_amount ON TABLE ai_reservation TYPE option<int>
  ASSERT $value = NONE OR ($value >= 0 AND $value <= max_amount);
DEFINE FIELD IF NOT EXISTS status ON TABLE ai_reservation TYPE string DEFAULT "reserved"
  ASSERT $value INSIDE ["reserved", "settled", "released", "expired"];
DEFINE FIELD IF NOT EXISTS outcome ON TABLE ai_reservation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS deadline ON TABLE ai_reservation TYPE datetime READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ai_reservation TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE ai_reservation TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS ai_reservation_idempotency_unique
  ON TABLE ai_reservation COLUMNS idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS ai_reservation_open_deadline
  ON TABLE ai_reservation COLUMNS status, deadline;
DEFINE INDEX IF NOT EXISTS ai_reservation_run
  ON TABLE ai_reservation COLUMNS run_id;

-- 状态机：只有 reserved 可迁移，且只能进 settled / released / expired 终态。
DEFINE EVENT OVERWRITE ai_reservation_status_guard ON TABLE ai_reservation
  WHEN $event = "UPDATE" AND $after.status != $before.status
  THEN {
    IF $before.status != "reserved" OR $after.status = "reserved" {
      THROW "ai_reservation: invalid status transition";
    };
  };

-- ── 账本：append-only 消费/变动记录（grant/reserve/settle/release/expire/writeoff）──
DEFINE TABLE IF NOT EXISTS ai_ledger_entry SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS kind ON TABLE ai_ledger_entry TYPE string
  ASSERT $value INSIDE ["grant", "reserve", "settle", "release", "expire", "writeoff"];
DEFINE FIELD IF NOT EXISTS bucket ON TABLE ai_ledger_entry TYPE option<record<ai_allowance_bucket>>;
DEFINE FIELD IF NOT EXISTS reservation ON TABLE ai_ledger_entry TYPE option<record<ai_reservation>>;
DEFINE FIELD IF NOT EXISTS amount ON TABLE ai_ledger_entry TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS resulting_available ON TABLE ai_ledger_entry TYPE option<int>;
DEFINE FIELD IF NOT EXISTS note ON TABLE ai_ledger_entry TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ai_ledger_entry TYPE datetime VALUE time::now() READONLY;
DEFINE EVENT OVERWRITE ai_ledger_entry_immutable ON TABLE ai_ledger_entry
  WHEN $event = "UPDATE" OR $event = "DELETE"
  THEN { THROW "immutable-ledger-entry"; };

-- ── 阈值提示：周期桶 × 档位唯一，天然去重不轰炸 ─────────────────────────────
DEFINE TABLE IF NOT EXISTS ai_allowance_notice SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS period_key ON TABLE ai_allowance_notice TYPE string;
DEFINE FIELD IF NOT EXISTS threshold ON TABLE ai_allowance_notice TYPE int
  ASSERT $value INSIDE [50, 80, 100];
DEFINE FIELD IF NOT EXISTS message ON TABLE ai_allowance_notice TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ai_allowance_notice TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS ai_allowance_notice_unique
  ON TABLE ai_allowance_notice COLUMNS period_key, threshold UNIQUE;
