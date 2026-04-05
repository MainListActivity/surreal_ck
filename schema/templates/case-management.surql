-- Case Management template provisioning script.
-- Idempotent: safe to re-run on an existing workspace.
-- Variables injected by the client before execution:
--   $ws  -- record<workspace>
--   $wb  -- record<workbook>

-- ─── Entity types ────────────────────────────────────────────────────────────

UPSERT entity_type:case_t CONTENT {
  workspace: $ws,
  key: "case",
  label: "Case",
  fields: [
    { key: "title",       label: "Case Title",  type: "text",          required: true  },
    { key: "matter_id",   label: "Matter ID",   type: "text",          required: false },
    { key: "status",      label: "Status",      type: "single_select", required: false,
      options: ["Open", "Pending", "Closed"] },
    { key: "opened_at",   label: "Opened",      type: "date",          required: false }
  ]
};

UPSERT entity_type:client_t CONTENT {
  workspace: $ws,
  key: "client",
  label: "Client",
  fields: [
    { key: "name",  label: "Client Name", type: "text", required: true  },
    { key: "email", label: "Email",       type: "text", required: false },
    { key: "phone", label: "Phone",       type: "text", required: false }
  ]
};

UPSERT entity_type:document_t CONTENT {
  workspace: $ws,
  key: "document",
  label: "Document",
  fields: [
    { key: "title",       label: "Document Title", type: "text",          required: true  },
    { key: "doc_type",    label: "Type",            type: "single_select", required: false,
      options: ["Motion", "Brief", "Order", "Contract", "Evidence"] },
    { key: "filed_at",    label: "Filed",           type: "date",          required: false }
  ]
};

-- ─── Relation types ───────────────────────────────────────────────────────────

UPSERT relation_type:assigned_to_t CONTENT {
  workspace: $ws,
  key: "assigned_to",
  label: "Assigned To"
};

UPSERT relation_type:filed_in_t CONTENT {
  workspace: $ws,
  key: "filed_in",
  label: "Filed In"
};

UPSERT relation_type:belongs_to_t CONTENT {
  workspace: $ws,
  key: "belongs_to",
  label: "Belongs To"
};

RELATE $ws->workspace_has_entity_type->entity_type:case_t;
RELATE $ws->workspace_has_entity_type->entity_type:client_t;
RELATE $ws->workspace_has_entity_type->entity_type:document_t;

RELATE $ws->workspace_has_relation_type->relation_type:assigned_to_t;
RELATE $ws->workspace_has_relation_type->relation_type:filed_in_t;
RELATE $ws->workspace_has_relation_type->relation_type:belongs_to_t;

RELATE relation_type:assigned_to_t->relation_from_type->entity_type:case_t;
RELATE relation_type:assigned_to_t->relation_to_type->entity_type:client_t;
RELATE relation_type:filed_in_t->relation_from_type->entity_type:case_t;
RELATE relation_type:filed_in_t->relation_to_type->entity_type:case_t;
RELATE relation_type:belongs_to_t->relation_from_type->entity_type:document_t;
RELATE relation_type:belongs_to_t->relation_to_type->entity_type:case_t;

-- ─── Dynamic entity tables (DDL, idempotent) ─────────────────────────────────
-- Permissions follow the standard workspace-scoped owner/member pattern.
-- Members can read; only the workspace owner can write.

DEFINE TABLE IF NOT EXISTS case SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE case TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title ON TABLE case TYPE string;
DEFINE FIELD IF NOT EXISTS matter_id ON TABLE case TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE case TYPE option<string>;
DEFINE FIELD IF NOT EXISTS opened_at ON TABLE case TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE case TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE case TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS case_workspace ON TABLE case COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS client SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE client TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name ON TABLE client TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE client TYPE option<string>;
DEFINE FIELD IF NOT EXISTS phone ON TABLE client TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE client TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE client TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS client_workspace ON TABLE client COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS document SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE document TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title ON TABLE document TYPE string;
DEFINE FIELD IF NOT EXISTS doc_type ON TABLE document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS filed_at ON TABLE document TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE document TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE document TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS document_workspace ON TABLE document COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS assigned_to TYPE RELATION IN case OUT client SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE assigned_to TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE assigned_to TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS filed_in TYPE RELATION IN case OUT case SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE filed_in TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE filed_in TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS belongs_to TYPE RELATION IN document OUT case SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE belongs_to TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE belongs_to TYPE datetime VALUE time::now();

-- ─── Form definition ─────────────────────────────────────────────────────────

UPSERT form_definition:matter_intake CONTENT {
  workspace: $ws,
  title: "Matter Intake",
  slug: "matter-intake",
  fields: [
    { key: "title",       label: "Case Title",    type: "text", required: true  },
    { key: "matter_id",   label: "Matter ID",     type: "text", required: false },
    { key: "client_name", label: "Client Name",   type: "text", required: true  },
    { key: "client_email",label: "Client Email",  type: "text", required: true  },
    { key: "description", label: "Description",   type: "text", required: false }
  ],
  conditional_rules: [],
  auto_relations: []
};

RELATE $ws->workspace_has_form_definition->form_definition:matter_intake;
RELATE form_definition:matter_intake->form_targets_entity_type->entity_type:case_t;

-- ─── Sample data ─────────────────────────────────────────────────────────────

BEGIN TRANSACTION;

LET $redwood_client = (UPSERT client:redwood CONTENT {
  workspace: $ws,
  name: "Redwood Group",
  email: "legal@redwood.example.com"
} RETURN id)[0].id;

LET $triton_client = (UPSERT client:triton CONTENT {
  workspace: $ws,
  name: "Triton Corp",
  email: "counsel@triton.example.com"
} RETURN id)[0].id;

LET $case1 = (UPSERT case:redwood_v_triton CONTENT {
  workspace: $ws,
  title: "Redwood v. Triton",
  matter_id: "2026-001",
  status: "Open",
  opened_at: time::now()
} RETURN id)[0].id;

LET $case2 = (UPSERT case:triton_v_harbor CONTENT {
  workspace: $ws,
  title: "Triton v. Harbor LLC",
  matter_id: "2026-002",
  status: "Pending",
  opened_at: time::now()
} RETURN id)[0].id;

LET $case3 = (UPSERT case:harbor_settlement CONTENT {
  workspace: $ws,
  title: "Harbor Settlement Review",
  matter_id: "2026-003",
  status: "Open",
  opened_at: time::now()
} RETURN id)[0].id;

LET $motion = (UPSERT document:motion_42 CONTENT {
  workspace: $ws,
  title: "Motion 42 — Summary Judgment",
  doc_type: "Motion",
  filed_at: time::now()
} RETURN id)[0].id;

RELATE $case1->assigned_to->$redwood_client CONTENT { workspace: $ws };
RELATE $case2->assigned_to->$triton_client CONTENT { workspace: $ws };
RELATE $motion->belongs_to->$case1 CONTENT { workspace: $ws };

COMMIT TRANSACTION;
