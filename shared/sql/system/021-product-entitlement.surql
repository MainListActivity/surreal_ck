-- 产品套餐聚合层。资源配额仍只用 quota_plan_revision。
-- 本文件不写入正式集合、额度或价格。

DEFINE TABLE IF NOT EXISTS content_collection SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS collection_key ON TABLE content_collection TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE content_collection TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE content_collection TYPE string
  ASSERT $value INSIDE ["active", "retired"];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_collection TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS content_collection_key_unique ON TABLE content_collection COLUMNS collection_key UNIQUE;

DEFINE TABLE IF NOT EXISTS content_template_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS collections ON TABLE content_template_revision TYPE array<object>;
DEFINE FIELD IF NOT EXISTS collections.*.collection ON TABLE content_template_revision TYPE record<content_collection>;
DEFINE FIELD IF NOT EXISTS collections.*.collection_key ON TABLE content_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS collections.*.display_name ON TABLE content_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS actions ON TABLE content_template_revision TYPE array<string>;
DEFINE FIELD IF NOT EXISTS actions.* ON TABLE content_template_revision TYPE string
  ASSERT $value INSIDE ["browse", "search", "read", "cite", "export"];
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE content_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE content_template_revision TYPE datetime DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS content_template_revision_immutable ON TABLE content_template_revision
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:content_template_revision";
  };

DEFINE TABLE IF NOT EXISTS ai_template_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS actions ON TABLE ai_template_revision TYPE array<string>;
DEFINE FIELD IF NOT EXISTS actions.* ON TABLE ai_template_revision TYPE string
  ASSERT $value INSIDE ["research", "generate"];
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE ai_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE ai_template_revision TYPE datetime DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS ai_template_revision_immutable ON TABLE ai_template_revision
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:ai_template_revision";
  };

DEFINE TABLE IF NOT EXISTS feature_template_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS features ON TABLE feature_template_revision TYPE array<object>;
DEFINE FIELD IF NOT EXISTS features.*.feature_key ON TABLE feature_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS features.*.enabled ON TABLE feature_template_revision TYPE bool;
DEFINE FIELD IF NOT EXISTS features.*.limit_value ON TABLE feature_template_revision TYPE option<int>
  ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE feature_template_revision TYPE string;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE feature_template_revision TYPE datetime DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS feature_template_revision_immutable ON TABLE feature_template_revision
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:feature_template_revision";
  };

DEFINE TABLE IF NOT EXISTS product_plan SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS plan_key ON TABLE product_plan TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE product_plan TYPE string;
DEFINE FIELD IF NOT EXISTS status ON TABLE product_plan TYPE string
  ASSERT $value INSIDE ["active", "retired"];
DEFINE FIELD IF NOT EXISTS active_revision ON TABLE product_plan TYPE option<record<product_plan_revision>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE product_plan TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE product_plan TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS product_plan_key_unique ON TABLE product_plan COLUMNS plan_key UNIQUE;

DEFINE TABLE IF NOT EXISTS product_plan_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS plan ON TABLE product_plan_revision TYPE record<product_plan>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE product_plan_revision TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS resource_template ON TABLE product_plan_revision TYPE record<quota_plan_revision>;
DEFINE FIELD IF NOT EXISTS content_template ON TABLE product_plan_revision TYPE record<content_template_revision>;
DEFINE FIELD IF NOT EXISTS ai_template ON TABLE product_plan_revision TYPE record<ai_template_revision>;
DEFINE FIELD IF NOT EXISTS feature_template ON TABLE product_plan_revision TYPE record<feature_template_revision>;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE product_plan_revision TYPE string;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE product_plan_revision TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE product_plan_revision TYPE string;
DEFINE INDEX IF NOT EXISTS product_plan_revision_unique ON TABLE product_plan_revision COLUMNS plan, revision UNIQUE;
DEFINE EVENT IF NOT EXISTS product_plan_revision_immutable ON TABLE product_plan_revision
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:product_plan_revision";
  };

DEFINE FIELD IF NOT EXISTS product_plan_revision ON TABLE quota_subscription_item
  TYPE option<record<product_plan_revision>>;

DEFINE TABLE IF NOT EXISTS content_grant SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE content_grant TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS label ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS collections ON TABLE content_grant TYPE array<object>;
DEFINE FIELD IF NOT EXISTS collections.*.collection ON TABLE content_grant TYPE record<content_collection>;
DEFINE FIELD IF NOT EXISTS collections.*.collection_key ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS collections.*.display_name ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS actions ON TABLE content_grant TYPE array<string>;
DEFINE FIELD IF NOT EXISTS actions.* ON TABLE content_grant TYPE string
  ASSERT $value INSIDE ["browse", "search", "read", "cite", "export"];
DEFINE FIELD IF NOT EXISTS effective_from ON TABLE content_grant TYPE datetime;
DEFINE FIELD IF NOT EXISTS effective_until ON TABLE content_grant TYPE option<datetime>
  ASSERT $value = NONE OR $value > effective_from;
DEFINE FIELD IF NOT EXISTS reason ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE content_grant TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_grant TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS content_grant_idempotency ON TABLE content_grant COLUMNS workspace, idempotency_key UNIQUE;
DEFINE EVENT IF NOT EXISTS content_grant_immutable ON TABLE content_grant
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:content_grant";
  };

DEFINE TABLE IF NOT EXISTS workspace_product_entitlement SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_product_entitlement TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS revision ON TABLE workspace_product_entitlement TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS digest ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS summary ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS resolver_version ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS base_source_kind ON TABLE workspace_product_entitlement TYPE string
  ASSERT $value INSIDE ["subscription", "trial", "none"];
DEFINE FIELD IF NOT EXISTS base_source_id ON TABLE workspace_product_entitlement TYPE option<string>;
DEFINE FIELD IF NOT EXISTS product_plan_revision ON TABLE workspace_product_entitlement TYPE option<record<product_plan_revision>>;
DEFINE FIELD IF NOT EXISTS product_plan_key ON TABLE workspace_product_entitlement TYPE option<string>;
DEFINE FIELD IF NOT EXISTS product_plan_name ON TABLE workspace_product_entitlement TYPE option<string>;
DEFINE FIELD IF NOT EXISTS product_revision_number ON TABLE workspace_product_entitlement TYPE option<int>;
DEFINE FIELD IF NOT EXISTS effective_from ON TABLE workspace_product_entitlement TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS effective_until ON TABLE workspace_product_entitlement TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS content_collections ON TABLE workspace_product_entitlement TYPE array<object>;
DEFINE FIELD IF NOT EXISTS content_collections.*.collection_key ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS content_collections.*.display_name ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS content_actions ON TABLE workspace_product_entitlement TYPE array<string>;
DEFINE FIELD IF NOT EXISTS content_actions.* ON TABLE workspace_product_entitlement TYPE string
  ASSERT $value INSIDE ["browse", "search", "read", "cite", "export"];
DEFINE FIELD IF NOT EXISTS content_sources ON TABLE workspace_product_entitlement TYPE array<object>;
DEFINE FIELD IF NOT EXISTS content_sources.*.kind ON TABLE workspace_product_entitlement TYPE string
  ASSERT $value INSIDE ["base", "grant"];
DEFINE FIELD IF NOT EXISTS content_sources.*.source_id ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS content_sources.*.label ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS content_sources.*.effective_from ON TABLE workspace_product_entitlement TYPE datetime;
DEFINE FIELD IF NOT EXISTS content_sources.*.effective_until ON TABLE workspace_product_entitlement TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS ai_actions ON TABLE workspace_product_entitlement TYPE array<string>;
DEFINE FIELD IF NOT EXISTS ai_actions.* ON TABLE workspace_product_entitlement TYPE string
  ASSERT $value INSIDE ["research", "generate"];
DEFINE FIELD IF NOT EXISTS features ON TABLE workspace_product_entitlement TYPE array<object>;
DEFINE FIELD IF NOT EXISTS features.*.feature_key ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS features.*.enabled ON TABLE workspace_product_entitlement TYPE bool;
DEFINE FIELD IF NOT EXISTS features.*.limit_value ON TABLE workspace_product_entitlement TYPE option<int>;
DEFINE FIELD IF NOT EXISTS correlation_id ON TABLE workspace_product_entitlement TYPE string;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE workspace_product_entitlement TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS workspace_product_entitlement_revision ON TABLE workspace_product_entitlement
  COLUMNS workspace, revision UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_product_entitlement_digest ON TABLE workspace_product_entitlement
  COLUMNS workspace, digest UNIQUE;
DEFINE EVENT IF NOT EXISTS workspace_product_entitlement_immutable ON TABLE workspace_product_entitlement
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:workspace_product_entitlement";
  };

DEFINE FIELD IF NOT EXISTS current_product_entitlement ON TABLE workspace
  TYPE option<record<workspace_product_entitlement>>;

DEFINE TABLE IF NOT EXISTS product_entitlement_audit SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS actor_subject ON TABLE product_entitlement_audit TYPE string;
DEFINE FIELD IF NOT EXISTS action ON TABLE product_entitlement_audit TYPE string
  ASSERT $value INSIDE ["publish", "assign", "grant"];
DEFINE FIELD IF NOT EXISTS workspace ON TABLE product_entitlement_audit TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS reason ON TABLE product_entitlement_audit TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE product_entitlement_audit TYPE string;
DEFINE FIELD IF NOT EXISTS request_digest ON TABLE product_entitlement_audit TYPE string;
DEFINE FIELD IF NOT EXISTS entitlement ON TABLE product_entitlement_audit TYPE option<record<workspace_product_entitlement>>;
DEFINE FIELD IF NOT EXISTS product_plan_revision ON TABLE product_entitlement_audit TYPE option<record<product_plan_revision>>;
DEFINE FIELD IF NOT EXISTS occurred_at ON TABLE product_entitlement_audit TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS product_entitlement_audit_idempotency ON TABLE product_entitlement_audit
  COLUMNS actor_subject, idempotency_key UNIQUE;
-- 先占幂等键时 entitlement 还是 NONE；只允许把它补成快照 id 一次。
DEFINE EVENT IF NOT EXISTS product_entitlement_audit_immutable ON TABLE product_entitlement_audit
  WHEN $event = "DELETE" OR (
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
