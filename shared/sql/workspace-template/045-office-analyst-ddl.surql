-- VO05：限定型提案与浏览器 admin 原子执行。只追加 schema，不改写业务数据。
DEFINE TABLE OVERWRITE office_ddl_intent SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE,
    FOR create WHERE $auth.kind = "virtual"
      AND $auth.virtual_profile.role_key = "data-analyst"
      AND author = $auth AND task.assignee = $auth AND status = "requested",
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS task ON TABLE office_ddl_intent TYPE option<record<office_task>> READONLY;
DEFINE FIELD IF NOT EXISTS notification ON TABLE office_ddl_intent TYPE option<record<user_notification>> READONLY;
DEFINE FIELD OVERWRITE op ON TABLE office_ddl_intent TYPE string READONLY
  ASSERT $value INSIDE ["define_table", "define_field", "define_index"];
DEFINE FIELD OVERWRITE status ON TABLE office_ddl_intent TYPE string DEFAULT "requested"
  ASSERT $value INSIDE ["requested", "approved", "executing", "succeeded", "rejected", "failed", "ambiguous", "reconciled"];

DEFINE EVENT OVERWRITE office_ddl_intent_status_guard ON TABLE office_ddl_intent
  WHEN $event = "UPDATE"
  THEN {
    IF $before.status INSIDE ["succeeded", "rejected", "failed", "reconciled"]
      AND ($after.status != $before.status OR $after.result != $before.result
        OR $after.decided_by != $before.decided_by OR $after.decided_at != $before.decided_at) {
      THROW "office_ddl_intent: terminal result cannot change";
    };
    IF $after.status != $before.status {
      LET $allowed = $before.status = "requested" AND $after.status INSIDE ["approved", "rejected"]
        OR $before.status = "approved" AND $after.status INSIDE ["executing", "rejected"]
        OR $before.status = "executing" AND $after.status INSIDE ["succeeded", "failed", "ambiguous"]
        OR $before.status = "ambiguous" AND $after.status = "reconciled";
      IF !$allowed { THROW "office_ddl_intent: invalid status transition"; };
      IF $token.ac != "admin" { THROW "office_ddl_intent: current admin access required"; };
      IF $after.result = NONE { THROW "office_ddl_intent: durable result required"; };
    };
    IF $before.decided_by != NONE AND $after.decided_by != $before.decided_by {
      THROW "office_ddl_intent: decided_by is terminal";
    };
  };

-- intent 与通知结果同一事务落库；普通收件人不能仅通过 answer 越过 DDL 确认。
DEFINE EVENT OVERWRITE office_ddl_intent_notification_result ON TABLE office_ddl_intent
  WHEN $event = "UPDATE" AND $after.status != $before.status
    AND $after.status INSIDE ["succeeded", "rejected", "failed", "reconciled"]
  THEN {
    UPDATE $after.notification SET resolved_at = time::now(),
      resolution = $after.result.message,
      answer = { action: IF $after.status = "rejected" { "rejected" } ELSE { "answered" },
        text: $after.result.message, ddl_status: $after.status }
      WHERE resolved_at = NONE;
  };

DEFINE EVENT OVERWRITE office_ddl_notification_guard ON TABLE user_notification
  WHEN $event = "UPDATE" AND $before.payload.question_type = "ddl"
    AND ($after.resolved_at != $before.resolved_at OR $after.answer != $before.answer
      OR $after.resolution != $before.resolution)
  THEN {
    IF $token.ac != "admin" { THROW "DDL notification: current admin access required"; };
    LET $intent = type::record($before.payload.ddl_intent);
    IF $intent.status NOTINSIDE ["succeeded", "rejected", "failed", "reconciled"] {
      THROW "DDL notification: intent must be terminal first";
    };
  };

-- PM 的唯一开岗能力：自己主管的 data-analyst；真人与其他岗位仍不可创建/修改。
DEFINE TABLE OVERWRITE user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth.is_admin = true OR (
      $auth.kind = "virtual" AND $auth.virtual_profile.role_key = "project-manager"
      AND $auth.virtual_profile.status = "active" AND kind = "virtual" AND is_admin = false
      AND virtual_profile.role_key = "data-analyst" AND virtual_profile.role = office_role:data_analyst
      AND virtual_profile.supervisor = $auth AND virtual_profile.status = NONE),
    FOR update WHERE id = $auth OR $auth.is_admin = true OR (
      $auth.kind = "virtual" AND $auth.virtual_profile.role_key = "project-manager"
      AND $auth.virtual_profile.status = "active" AND kind = "virtual" AND is_admin = false
      AND virtual_profile.role_key = "data-analyst" AND virtual_profile.supervisor = $auth),
    FOR delete WHERE $auth.is_admin = true;

DEFINE EVENT OVERWRITE office_analyst_provision_guard ON TABLE user
  WHEN $event = "UPDATE" AND $auth.kind = "virtual" AND $auth.id != $after.id
  THEN {
    IF $before.kind != "virtual" OR $after.kind != $before.kind
      OR $after.is_admin != $before.is_admin OR $after.subject != $before.subject
      OR $after.email != $before.email OR $after.virtual_profile.role != $before.virtual_profile.role
      OR $after.virtual_profile.role_key != $before.virtual_profile.role_key
      OR $after.virtual_profile.supervisor != $before.virtual_profile.supervisor
      OR $before.virtual_profile.supervisor != $auth
      OR $before.virtual_profile.role_key != "data-analyst"
      OR $before.virtual_profile.status != NONE OR $after.virtual_profile.status != "active" {
      THROW "office analyst: only provisioning activation is allowed";
    };
  };
