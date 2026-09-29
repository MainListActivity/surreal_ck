-- VO01 虚拟办公室最小领域 + user_notification 通用化。
--
-- 每 workspace 一个 database：本增量随 migration-runner 应用到新旧 workspace，
-- DEFINE/INSERT 全部幂等。所有归因走 fn::current_user() / $auth（employee、participant
-- 的 RECORD 会话与 admin JWT 都能解析），不出现手工 from_* 身份字段。
--
-- 状态机由 DEFINE EVENT 守卫：PERMISSIONS 的 FOR update 只能看到更新后的文档，
-- 真正的"终态不可重开/非法迁移拒绝"在事件里比较 $before/$after 并 THROW 回滚。

-- ── 办公室元数据：每 workspace 单例（约定 id = office_meta:office） ──────────
DEFINE TABLE IF NOT EXISTS office_meta SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    -- 所有权元数据仅管理员可写；admin 走 system RBAC，RECORD 侧只放行 is_admin。
    FOR create, update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS goal ON TABLE office_meta TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS primary_contact ON TABLE office_meta TYPE option<record<user>>
  ASSERT $value = NONE OR $value.kind = "human";
DEFINE FIELD IF NOT EXISTS state ON TABLE office_meta TYPE string DEFAULT "pending"
  ASSERT $value INSIDE ["pending", "onboarding", "active"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_meta TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE office_meta TYPE datetime VALUE time::now();

-- ── 持久任务：assigner/assignee/parent/depth 创建后不可改，状态机受 EVENT 守卫 ──
DEFINE TABLE IF NOT EXISTS office_task SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    -- 创建时 assigner 必须是自己；status 由 DEFAULT 兜底为 open，禁止直接建终态。
    FOR create WHERE assigner = fn::current_user() AND status = "open",
    -- assignee 推进自己的任务；assigner 修订；管理员兜底。
    FOR update WHERE
      assignee = $auth
      OR assigner = fn::current_user()
      OR $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS goal ON TABLE office_task TYPE string;
DEFINE FIELD IF NOT EXISTS assigner ON TABLE office_task TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS assignee ON TABLE office_task TYPE record<user> READONLY
  ASSERT $value.kind != "virtual" OR $value.virtual_profile.status = "active";
DEFINE FIELD IF NOT EXISTS parent ON TABLE office_task TYPE option<record<office_task>> READONLY;
DEFINE FIELD IF NOT EXISTS depth ON TABLE office_task TYPE int DEFAULT 0 READONLY
  ASSERT (parent = NONE AND $value = 0)
    OR (parent != NONE AND $value = parent.depth + 1 AND $value <= 8);
DEFINE FIELD IF NOT EXISTS status ON TABLE office_task TYPE string DEFAULT "open"
  ASSERT $value INSIDE ["open", "in_progress", "blocked", "done", "cancelled"];
DEFINE FIELD IF NOT EXISTS due_at ON TABLE office_task TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS result ON TABLE office_task TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_task TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE office_task TYPE datetime VALUE time::now();

-- 状态机：open / in_progress / blocked 之间可互转或进入终态 done / cancelled；终态即封闭。
DEFINE EVENT OVERWRITE office_task_status_guard ON TABLE office_task
  WHEN $event = "UPDATE" AND $after.status != $before.status
  THEN {
    IF $before.status NOTINSIDE ["open", "in_progress", "blocked"] {
      THROW "office_task: terminal status cannot change";
    };
  };

-- ── 消息：append-only，作者与内容发布后不可改写 ────────────────────────────
DEFINE TABLE IF NOT EXISTS office_message SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE author = fn::current_user(),
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS author ON TABLE office_message TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS task ON TABLE office_message TYPE option<record<office_task>> READONLY;
DEFINE FIELD IF NOT EXISTS to ON TABLE office_message TYPE option<record<user>> READONLY;
DEFINE FIELD IF NOT EXISTS body ON TABLE office_message TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS in_reply_to ON TABLE office_message TYPE option<record<office_message>> READONLY;
DEFINE FIELD IF NOT EXISTS mentions ON TABLE office_message TYPE option<array<record<user>>> READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_message TYPE datetime VALUE time::now() READONLY;

-- ── 报告：append-only，作者、task 关联与正文不可改写 ───────────────────────
DEFINE TABLE IF NOT EXISTS office_report SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE author = fn::current_user(),
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS author ON TABLE office_report TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS to ON TABLE office_report TYPE record<user> READONLY;
DEFINE FIELD IF NOT EXISTS task ON TABLE office_report TYPE option<record<office_task>> READONLY;
DEFINE FIELD IF NOT EXISTS summary ON TABLE office_report TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS next_steps ON TABLE office_report TYPE option<array<string>> READONLY;
DEFINE FIELD IF NOT EXISTS blocked_by ON TABLE office_report TYPE option<string> READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_report TYPE datetime VALUE time::now() READONLY;

-- ── DDL intent：员工提案、管理员浏览器确认执行；终态结果封闭 ────────────────
DEFINE TABLE IF NOT EXISTS office_ddl_intent SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    -- 只有员工提案入口；status 由 DEFAULT 兜底为 requested。
    FOR create WHERE author = fn::current_user() AND status = "requested",
    -- 审批与执行回执只有管理员能写（admin 走 system RBAC）。
    FOR update WHERE $auth.is_admin = true,
    FOR delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS author ON TABLE office_ddl_intent TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD IF NOT EXISTS op ON TABLE office_ddl_intent TYPE string READONLY
  ASSERT $value INSIDE ["define_table", "define_field", "define_index", "define_analyzer", "other"];
DEFINE FIELD IF NOT EXISTS spec ON TABLE office_ddl_intent TYPE object FLEXIBLE READONLY;
DEFINE FIELD IF NOT EXISTS rationale ON TABLE office_ddl_intent TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS impact ON TABLE office_ddl_intent TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS fingerprint ON TABLE office_ddl_intent TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS status ON TABLE office_ddl_intent TYPE string DEFAULT "requested"
  ASSERT $value INSIDE ["requested", "approved", "executing", "succeeded", "rejected", "failed"];
DEFINE FIELD IF NOT EXISTS decided_by ON TABLE office_ddl_intent TYPE option<record<user>>
  ASSERT $value = NONE OR $value.kind = "human";
DEFINE FIELD IF NOT EXISTS decided_at ON TABLE office_ddl_intent TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS result ON TABLE office_ddl_intent TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE office_ddl_intent TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE office_ddl_intent TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS office_ddl_intent_fingerprint_unique
  ON TABLE office_ddl_intent COLUMNS fingerprint UNIQUE;

-- 状态机：requested → approved/rejected；approved → executing/rejected；
-- executing → succeeded/failed；终态与决定人一经落库不可改。
DEFINE EVENT OVERWRITE office_ddl_intent_status_guard ON TABLE office_ddl_intent
  WHEN $event = "UPDATE"
  THEN {
    IF $after.status != $before.status {
      LET $allowed = $before.status = "requested" AND $after.status INSIDE ["approved", "rejected"]
        OR $before.status = "approved" AND $after.status INSIDE ["executing", "rejected"]
        OR $before.status = "executing" AND $after.status INSIDE ["succeeded", "failed"];
      IF !$allowed {
        THROW "office_ddl_intent: invalid status transition";
      };
    };
    IF $before.decided_by != NONE AND $after.decided_by != $before.decided_by {
      THROW "office_ddl_intent: decided_by is terminal";
    };
  };

-- ── user_notification 通用化：保留债权字段语义，扩展为通用人类注意力通道 ──────
-- 债权专属字段放宽为可选（存量行不受影响），新增 purpose/payload/task/answer。
DEFINE FIELD OVERWRITE workbook ON TABLE user_notification TYPE option<record<workbook>>;
DEFINE FIELD OVERWRITE related_record ON TABLE user_notification TYPE option<record>;
DEFINE FIELD OVERWRITE risk_type ON TABLE user_notification TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["missing-material", "due-within-seven-days", "amount-anomaly"];
DEFINE FIELD OVERWRITE matched_fields ON TABLE user_notification TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE rule ON TABLE user_notification TYPE option<string>;
DEFINE FIELD OVERWRITE checked_at ON TABLE user_notification TYPE option<datetime>;
-- 发送者与接收者创建后不可改写；去重仍走 dedupe_key 唯一索引 + ON DUPLICATE 原语义。
DEFINE FIELD OVERWRITE from_employee ON TABLE user_notification TYPE record<user>
  DEFAULT fn::current_user() READONLY;
DEFINE FIELD OVERWRITE to_user ON TABLE user_notification TYPE record<user> READONLY;
-- 存量行没有 purpose：TYPE 必须允许 NONE，否则任何 UPDATE 都会 coerce 失败。
DEFINE FIELD IF NOT EXISTS purpose ON TABLE user_notification TYPE option<string> DEFAULT "claims-risk"
  ASSERT $value = NONE OR $value INSIDE ["claims-risk", "office-request", "info"];
DEFINE FIELD IF NOT EXISTS payload ON TABLE user_notification TYPE option<object> FLEXIBLE READONLY;
DEFINE FIELD IF NOT EXISTS task ON TABLE user_notification TYPE option<record<office_task>>;
DEFINE FIELD IF NOT EXISTS answer ON TABLE user_notification TYPE option<object> FLEXIBLE;

-- 解决一旦落库即终态：resolved_at / resolution 不允许二次改写，重复提交天然幂等。
DEFINE EVENT OVERWRITE user_notification_resolution_guard ON TABLE user_notification
  WHEN $event = "UPDATE"
  THEN {
    IF $before.resolved_at != NONE AND $after.resolved_at != $before.resolved_at {
      THROW "user_notification: resolution is terminal";
    };
    IF $before.resolution != NONE AND $after.resolution != $before.resolution {
      THROW "user_notification: resolution is terminal";
    };
  };

-- ── 默认岗位定义：幂等 seed，不创建员工实例或凭证 ───────────────────────────
INSERT INTO office_role [
  {
    id: office_role:project_manager,
    key: "project-manager",
    label: "项目经理",
    system_prompt: "你是虚拟办公室的项目经理。职责：把 office_meta.goal 拆解为可执行的 office_task，委派给状态为 active 的岗位；通过 office_message 与员工和真人沟通；阻塞时向 primary_contact 发起 user_notification(purpose=office-request) 请求信息；里程碑与最终结果以 office_report 交付。约束：不越权创建任务（assigner 必须是自己），不猜测缺失信息，不写代码不直接改库结构。",
    tool_bundle_key: "office-project-manager",
    heartbeat_interval: 5m,
    daily_token_budget: 200000,
  },
  {
    id: office_role:data_analyst,
    key: "data-analyst",
    label: "数据分析师",
    system_prompt: "你是虚拟办公室的数据分析师。职责：在指派的 office_task 内检查 workspace 数据、产出分析结论并以 office_report 交付；需要结构变更时提交 office_ddl_intent（typed op + spec + rationale + impact + fingerprint），等待管理员在浏览器确认执行，绝不自行尝试 DDL。进展与阻塞经 office_message 同步给项目经理。",
    tool_bundle_key: "office-data-analyst",
    heartbeat_interval: 5m,
    daily_token_budget: 200000,
    default_supervisor_role: "project-manager",
  },
]
ON DUPLICATE KEY UPDATE updated_at = updated_at;
