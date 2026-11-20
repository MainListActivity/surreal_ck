-- 测试 workspace 拆除豁免：测试标记 workspace（test_expires_at 非空）名下
-- 的控制面不可变行允许 DELETE，UPDATE 仍全部禁止。测试账号清理
-- （test_kit_purge / 到期 reaper）需要整库删除这些行；此前 DELETE 触发
-- immutable 事件，清理已删库后仍抛错，外部表现为 internal error。
-- 真实 workspace 行保持完全不可变；无 workspace 标记的行（含 workspace 为
-- NONE 的全局行）同样不可变。
DEFINE EVENT OVERWRITE quota_override_revision_immutable ON TABLE quota_override_revision
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_override_revision";
  };

DEFINE EVENT OVERWRITE resource_entitlement_immutable ON TABLE resource_entitlement
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:resource_entitlement";
  };

DEFINE EVENT OVERWRITE quota_policy_projection_immutable ON TABLE quota_policy_projection
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_policy_projection";
  };

DEFINE EVENT OVERWRITE entitlement_operation_immutable ON TABLE entitlement_operation
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:entitlement_operation";
  };

DEFINE EVENT OVERWRITE quota_materialization_terminal_guard ON TABLE quota_materialization_operation
  WHEN ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
    OR (
      $event = "UPDATE"
      AND $before.status INSIDE ["succeeded", "superseded"]
    )
  THEN {
    THROW "immutable-control-plane-record:quota_materialization_operation";
  };

DEFINE EVENT OVERWRITE quota_operator_intent_immutable ON TABLE quota_operator_intent
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_operator_intent";
  };

DEFINE EVENT OVERWRITE quota_audit_event_immutable ON TABLE quota_audit_event
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_audit_event";
  };

DEFINE EVENT OVERWRITE quota_notification_outbox_immutable ON TABLE quota_notification_outbox
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_notification_outbox";
  };

DEFINE EVENT OVERWRITE quota_migration_inventory_immutable ON TABLE quota_migration_inventory
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_migration_inventory";
  };

DEFINE EVENT OVERWRITE quota_migration_assignment_immutable ON TABLE quota_migration_assignment
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_migration_assignment";
  };

DEFINE EVENT OVERWRITE quota_migration_signal_immutable ON TABLE quota_migration_signal
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:quota_migration_signal";
  };

DEFINE EVENT OVERWRITE content_grant_immutable ON TABLE content_grant
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:content_grant";
  };

DEFINE EVENT OVERWRITE workspace_product_entitlement_immutable ON TABLE workspace_product_entitlement
  WHEN $event = "UPDATE"
    OR ($event = "DELETE" AND $before.workspace.test_expires_at = NONE)
  THEN {
    THROW "immutable-control-plane-record:workspace_product_entitlement";
  };

DEFINE EVENT OVERWRITE product_entitlement_audit_immutable ON TABLE product_entitlement_audit
  WHEN ($event = "DELETE" AND $before.workspace.test_expires_at = NONE) OR (
    $event = "UPDATE" AND (
      $before.entitlement != NONE
      OR $after.entitlement = NONE
      OR $before.actor_subject != $after.actor_subject
      OR $before.action != $after.action
      OR $before.idempotency_key != $after.idempotency_key
      OR $before.request_digest != $after.request_digest
      OR $before.product_plan_revision != $after.product_plan_revision
      OR $before.workspace != $after.workspace
      OR $before.reason != $after.reason
    )
  ) THEN {
    THROW "immutable-control-plane-record:product_entitlement_audit";
  };
