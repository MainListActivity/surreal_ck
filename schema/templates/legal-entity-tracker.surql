-- Legal Entity Tracker template provisioning script.
-- Idempotent: safe to re-run on an existing workspace.
-- Run DDL first (DEFINE TABLE/FIELD), then DML in a transaction.
-- Variables injected by the client before execution:
--   $ws  -- record<workspace> e.g. workspace:abc123
--   $wb  -- record<workbook>  e.g. workbook:def456

-- ─── Entity types ────────────────────────────────────────────────────────────

UPSERT entity_type:company_t CONTENT {
  workspace_key: <string>$ws,
  key: "company",
  label: "Company",
  fields: [
    { key: "name",         label: "Name",         type: "text",          required: true },
    { key: "jurisdiction", label: "Jurisdiction",  type: "text",          required: false },
    { key: "status",       label: "Status",        type: "single_select", required: false,
      options: ["Active", "Dissolved", "Pending"] }
  ]
};

UPSERT entity_type:person_t CONTENT {
  workspace_key: <string>$ws,
  key: "person",
  label: "Person",
  fields: [
    { key: "name",  label: "Full Name", type: "text", required: true },
    { key: "email", label: "Email",     type: "text", required: false },
    { key: "role",  label: "Role",      type: "text", required: false }
  ]
};

UPSERT entity_type:trust_t CONTENT {
  workspace_key: <string>$ws,
  key: "trust",
  label: "Trust",
  fields: [
    { key: "name",       label: "Trust Name",  type: "text", required: true },
    { key: "trustee",    label: "Trustee",     type: "text", required: false },
    { key: "settled_at", label: "Settled Date", type: "date", required: false }
  ]
};

-- ─── Relation types ───────────────────────────────────────────────────────────

UPSERT relation_type:owns_t CONTENT {
  workspace_key: <string>$ws,
  key: "owns",
  label: "Owns"
};

UPSERT relation_type:controls_t CONTENT {
  workspace_key: <string>$ws,
  key: "controls",
  label: "Controls"
};

UPSERT relation_type:filed_by_t CONTENT {
  workspace_key: <string>$ws,
  key: "filed_by",
  label: "Filed By"
};

RELATE $ws->workspace_has_entity_type->entity_type:company_t;
RELATE $ws->workspace_has_entity_type->entity_type:person_t;
RELATE $ws->workspace_has_entity_type->entity_type:trust_t;

RELATE $ws->workspace_has_relation_type->relation_type:owns_t;
RELATE $ws->workspace_has_relation_type->relation_type:controls_t;
RELATE $ws->workspace_has_relation_type->relation_type:filed_by_t;

RELATE relation_type:owns_t->relation_from_type->entity_type:company_t;
RELATE relation_type:owns_t->relation_to_type->entity_type:company_t;
RELATE relation_type:controls_t->relation_from_type->entity_type:company_t;
RELATE relation_type:controls_t->relation_to_type->entity_type:company_t;
RELATE relation_type:filed_by_t->relation_from_type->entity_type:company_t;
RELATE relation_type:filed_by_t->relation_to_type->entity_type:person_t;

-- ─── Dynamic entity tables (DDL, idempotent) ─────────────────────────────────

DEFINE TABLE IF NOT EXISTS company SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE company TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name ON TABLE company TYPE string;
DEFINE FIELD IF NOT EXISTS jurisdiction ON TABLE company TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE company TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE company TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS company_workspace ON TABLE company COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS person SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE person TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name ON TABLE person TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE person TYPE option<string>;
DEFINE FIELD IF NOT EXISTS role ON TABLE person TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE person TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS person_workspace ON TABLE person COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS trust SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE trust TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name ON TABLE trust TYPE string;
DEFINE FIELD IF NOT EXISTS trustee ON TABLE trust TYPE option<string>;
DEFINE FIELD IF NOT EXISTS settled_at ON TABLE trust TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE trust TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS trust_workspace ON TABLE trust COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS owns TYPE RELATION IN company OUT company SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS controls TYPE RELATION IN company OUT company SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS filed_by TYPE RELATION IN company OUT person SCHEMALESS PERMISSIONS FULL;

-- ─── Form definition ─────────────────────────────────────────────────────────

UPSERT form_definition:new_client_intake CONTENT {
  workspace_key: <string>$ws,
  title: "New Client Intake",
  slug: "new-client-intake",
  fields: [
    { key: "name",         label: "Company Name",  type: "text",   required: true  },
    { key: "jurisdiction", label: "Jurisdiction",  type: "text",   required: false },
    { key: "contact_name", label: "Contact Name",  type: "text",   required: true  },
    { key: "contact_email",label: "Contact Email", type: "text",   required: true  },
    { key: "notes",        label: "Notes",         type: "text",   required: false }
  ],
  conditional_rules: [],
  auto_relations: []
};

RELATE $ws->workspace_has_form_definition->form_definition:new_client_intake;
RELATE form_definition:new_client_intake->form_targets_entity_type->entity_type:company_t;

-- ─── Sample data (DML — inside transaction for rollback safety) ───────────────

BEGIN TRANSACTION;

LET $acme = (UPSERT company:acme_holdings CONTENT {
  workspace: $ws,
  name: "Acme Holdings",
  jurisdiction: "Delaware",
  status: "Active"
} RETURN id)[0].id;

LET $beta = (UPSERT company:beta_llc CONTENT {
  workspace: $ws,
  name: "Beta LLC",
  jurisdiction: "Hong Kong",
  status: "Active"
} RETURN id)[0].id;

LET $gamma = (UPSERT company:gamma_inc CONTENT {
  workspace: $ws,
  name: "Gamma Inc",
  jurisdiction: "Singapore",
  status: "Pending"
} RETURN id)[0].id;

LET $chen = (UPSERT person:chen_wei CONTENT {
  workspace: $ws,
  name: "Chen Wei",
  email: "chen@example.com",
  role: "Director"
} RETURN id)[0].id;

RELATE $acme->owns->$beta CONTENT { workspace: $ws };
RELATE $beta->controls->$gamma CONTENT { workspace: $ws };
RELATE $gamma->filed_by->$chen CONTENT { workspace: $ws };

COMMIT TRANSACTION;
