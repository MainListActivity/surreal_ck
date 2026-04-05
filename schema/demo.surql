-- demo.surql — Harbor Legal Ops demo seed
-- Idempotent: safe to re-run. All statements use UPSERT / IF NOT EXISTS.
-- Run after main.surql and both template provisioning scripts.
-- Assumes NS main DB docs.
--
-- What this inserts:
--   1. app_user   — two demo users
--   2. workspace  — "Harbor Legal Ops"
--   3. workbook   — Legal Entity Tracker + Case Management
--   4. workspace_member × 4 (admin + editor + 2 viewers)
--   5. owns_workspace / workspace_has_workbook / workspace_has_member / member_identifies_user edges
--   6. Template entity/relation types and form definitions (delegates to template scripts via RELATE)
--   7. Sample company/person/case/client/document records with graph relations
--   8. Three demo mutation records with actor edges (drives "Recent changes" panel)

USE NS main DB docs;

-- ─── 1. Demo users ────────────────────────────────────────────────────────────

UPSERT app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1` CONTENT {
  subject:      "demo|yc-chen",
  email:        "yc@harbor-legal.example.com",
  name:         "YC Chen",
  display_name: "YC Chen",
  status:       "active"
};

UPSERT app_user:demo_wong CONTENT {
  subject:      "demo|a-wong",
  email:        "awong@harbor-legal.example.com",
  name:         "A. Wong",
  display_name: "A. Wong",
  status:       "active"
};

UPSERT app_user:demo_rivera CONTENT {
  subject:      "demo|m-rivera",
  email:        "mrivera@harbor-legal.example.com",
  name:         "M. Rivera",
  display_name: "M. Rivera",
  status:       "active"
};

UPSERT app_user:demo_guest CONTENT {
  subject:      "demo|guest",
  email:        "guest@harbor-legal.example.com",
  name:         "Guest Viewer",
  display_name: "Guest Viewer",
  status:       "active"
};

-- ─── 2. Workspace ─────────────────────────────────────────────────────────────

UPSERT workspace:harbor CONTENT {
  name: "Harbor Legal Ops",
  slug: "harbor-legal-ops"
};

-- ─── 3. Workbooks ─────────────────────────────────────────────────────────────

UPSERT workbook:legal_entities CONTENT {
  name:        "Legal Entity Tracker",
  template_key: "legal-entity-tracker"
};

UPSERT workbook:case_ops CONTENT {
  name:        "Case Management",
  template_key: "case-management"
};

-- ─── 4. Workspace members ─────────────────────────────────────────────────────

UPSERT workspace_member:harbor_yc CONTENT {
  workspace: workspace:harbor,
  email:     "yc@harbor-legal.example.com",
  role:      "admin"
};

UPSERT workspace_member:harbor_wong CONTENT {
  workspace: workspace:harbor,
  email:     "awong@harbor-legal.example.com",
  role:      "editor"
};

UPSERT workspace_member:harbor_rivera CONTENT {
  workspace: workspace:harbor,
  email:     "mrivera@harbor-legal.example.com",
  role:      "editor"
};

UPSERT workspace_member:harbor_guest CONTENT {
  workspace: workspace:harbor,
  email:     "guest@harbor-legal.example.com",
  role:      "viewer"
};

-- ─── 5. Structural edges ──────────────────────────────────────────────────────

RELATE app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1`->owns_workspace->workspace:harbor;

RELATE workspace:harbor->workspace_has_workbook->workbook:legal_entities;
RELATE workspace:harbor->workspace_has_workbook->workbook:case_ops;

RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_yc;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_wong;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_rivera;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_guest;

RELATE workspace_member:harbor_yc->member_identifies_user->app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1`;
RELATE workspace_member:harbor_wong->member_identifies_user->app_user:demo_wong;
RELATE workspace_member:harbor_rivera->member_identifies_user->app_user:demo_rivera;
RELATE workspace_member:harbor_guest->member_identifies_user->app_user:demo_guest;

-- ─── 6. Legal Entity Tracker — entity/relation types + form ───────────────────
-- (Mirrors legal-entity-tracker.surql but scoped to workspace:harbor)

LET $ws = workspace:harbor;
LET $wb = workbook:legal_entities;

UPSERT entity_type:company_t CONTENT {
  workspace: $ws,
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
  workspace: $ws,
  key: "person",
  label: "Person",
  fields: [
    { key: "name",  label: "Full Name", type: "text", required: true },
    { key: "email", label: "Email",     type: "text", required: false },
    { key: "role",  label: "Role",      type: "text", required: false }
  ]
};

UPSERT entity_type:trust_t CONTENT {
  workspace: $ws,
  key: "trust",
  label: "Trust",
  fields: [
    { key: "name",       label: "Trust Name",   type: "text", required: true },
    { key: "trustee",    label: "Trustee",      type: "text", required: false },
    { key: "settled_at", label: "Settled Date", type: "date", required: false }
  ]
};

UPSERT relation_type:owns_t    CONTENT { workspace: $ws, key: "owns",     label: "Owns" };
UPSERT relation_type:controls_t CONTENT { workspace: $ws, key: "controls", label: "Controls" };
UPSERT relation_type:filed_by_t CONTENT { workspace: $ws, key: "filed_by", label: "Filed By" };

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

DEFINE TABLE IF NOT EXISTS company  SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD  IF NOT EXISTS workspace   ON TABLE company TYPE record<workspace>;
DEFINE FIELD  IF NOT EXISTS name        ON TABLE company TYPE string;
DEFINE FIELD  IF NOT EXISTS jurisdiction ON TABLE company TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS status      ON TABLE company TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS created_at  ON TABLE company TYPE datetime VALUE time::now();
DEFINE INDEX  IF NOT EXISTS company_workspace ON TABLE company COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS person SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD  IF NOT EXISTS workspace  ON TABLE person TYPE record<workspace>;
DEFINE FIELD  IF NOT EXISTS name       ON TABLE person TYPE string;
DEFINE FIELD  IF NOT EXISTS email      ON TABLE person TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS role       ON TABLE person TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS created_at ON TABLE person TYPE datetime VALUE time::now();
DEFINE INDEX  IF NOT EXISTS person_workspace ON TABLE person COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS owns     TYPE RELATION IN company OUT company SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS controls TYPE RELATION IN company OUT company SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS filed_by TYPE RELATION IN company OUT person  SCHEMALESS PERMISSIONS FULL;

UPSERT form_definition:new_client_intake CONTENT {
  workspace: $ws,
  title: "New Client Intake",
  slug:  "new-client-intake",
  fields: [
    { key: "name",          label: "Company Name",  type: "text", required: true  },
    { key: "jurisdiction",  label: "Jurisdiction",  type: "text", required: false },
    { key: "contact_name",  label: "Contact Name",  type: "text", required: true  },
    { key: "contact_email", label: "Contact Email", type: "text", required: true  },
    { key: "notes",         label: "Notes",         type: "text", required: false }
  ],
  conditional_rules: [],
  auto_relations: []
};

RELATE $ws->workspace_has_form_definition->form_definition:new_client_intake;
RELATE form_definition:new_client_intake->form_targets_entity_type->entity_type:company_t;

-- ─── 7a. Company + person sample data ─────────────────────────────────────────

BEGIN TRANSACTION;

LET $acme = (UPSERT company:acme_holdings CONTENT {
  workspace: workspace:harbor,
  name: "Acme Holdings",
  jurisdiction: "Delaware",
  status: "Active"
} RETURN id)[0].id;

LET $beta = (UPSERT company:beta_llc CONTENT {
  workspace: workspace:harbor,
  name: "Beta LLC",
  jurisdiction: "Hong Kong",
  status: "Active"
} RETURN id)[0].id;

LET $gamma = (UPSERT company:gamma_inc CONTENT {
  workspace: workspace:harbor,
  name: "Gamma Inc",
  jurisdiction: "Singapore",
  status: "Pending"
} RETURN id)[0].id;

LET $chen = (UPSERT person:chen_wei CONTENT {
  workspace: workspace:harbor,
  name: "Chen Wei",
  email: "chen@example.com",
  role: "Director"
} RETURN id)[0].id;

RELATE $acme->owns->$beta    CONTENT { workspace: workspace:harbor };
RELATE $beta->controls->$gamma CONTENT { workspace: workspace:harbor };
RELATE $gamma->filed_by->$chen CONTENT { workspace: workspace:harbor };

COMMIT TRANSACTION;

-- ─── 6b. Case Management — entity/relation types + form ───────────────────────

LET $ws = workspace:harbor;
LET $wb = workbook:case_ops;

UPSERT entity_type:case_t CONTENT {
  workspace: $ws,
  key: "case",
  label: "Case",
  fields: [
    { key: "title",     label: "Case Title", type: "text",          required: true },
    { key: "matter_id", label: "Matter ID",  type: "text",          required: false },
    { key: "status",    label: "Status",     type: "single_select", required: false,
      options: ["Open", "Pending", "Closed"] },
    { key: "opened_at", label: "Opened",     type: "date",          required: false }
  ]
};

UPSERT entity_type:client_t CONTENT {
  workspace: $ws,
  key: "client",
  label: "Client",
  fields: [
    { key: "name",  label: "Name",  type: "text", required: true },
    { key: "email", label: "Email", type: "text", required: false },
    { key: "phone", label: "Phone", type: "text", required: false }
  ]
};

UPSERT entity_type:document_t CONTENT {
  workspace: $ws,
  key: "document",
  label: "Document",
  fields: [
    { key: "title",    label: "Title",    type: "text",          required: true },
    { key: "doc_type", label: "Doc Type", type: "single_select", required: false,
      options: ["Motion", "Brief", "Order", "Contract", "Evidence"] },
    { key: "filed_at", label: "Filed",    type: "date",          required: false }
  ]
};

UPSERT relation_type:assigned_to_t CONTENT { workspace: $ws, key: "assigned_to", label: "Assigned To" };
UPSERT relation_type:filed_in_t    CONTENT { workspace: $ws, key: "filed_in",    label: "Filed In" };
UPSERT relation_type:belongs_to_t  CONTENT { workspace: $ws, key: "belongs_to",  label: "Belongs To" };

RELATE $ws->workspace_has_entity_type->entity_type:case_t;
RELATE $ws->workspace_has_entity_type->entity_type:client_t;
RELATE $ws->workspace_has_entity_type->entity_type:document_t;

RELATE $ws->workspace_has_relation_type->relation_type:assigned_to_t;
RELATE $ws->workspace_has_relation_type->relation_type:filed_in_t;
RELATE $ws->workspace_has_relation_type->relation_type:belongs_to_t;

DEFINE TABLE IF NOT EXISTS case        SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD  IF NOT EXISTS workspace  ON TABLE case TYPE record<workspace>;
DEFINE FIELD  IF NOT EXISTS title      ON TABLE case TYPE string;
DEFINE FIELD  IF NOT EXISTS matter_id  ON TABLE case TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS status     ON TABLE case TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS opened_at  ON TABLE case TYPE option<datetime>;
DEFINE FIELD  IF NOT EXISTS created_at ON TABLE case TYPE datetime VALUE time::now();
DEFINE INDEX  IF NOT EXISTS case_workspace ON TABLE case COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS client      SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD  IF NOT EXISTS workspace  ON TABLE client TYPE record<workspace>;
DEFINE FIELD  IF NOT EXISTS name       ON TABLE client TYPE string;
DEFINE FIELD  IF NOT EXISTS email      ON TABLE client TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS phone      ON TABLE client TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS created_at ON TABLE client TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS document    SCHEMALESS PERMISSIONS FULL;
DEFINE FIELD  IF NOT EXISTS workspace  ON TABLE document TYPE record<workspace>;
DEFINE FIELD  IF NOT EXISTS title      ON TABLE document TYPE string;
DEFINE FIELD  IF NOT EXISTS doc_type   ON TABLE document TYPE option<string>;
DEFINE FIELD  IF NOT EXISTS filed_at   ON TABLE document TYPE option<datetime>;
DEFINE FIELD  IF NOT EXISTS created_at ON TABLE document TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS assigned_to TYPE RELATION IN case OUT client   SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS filed_in    TYPE RELATION IN case OUT case     SCHEMALESS PERMISSIONS FULL;
DEFINE TABLE IF NOT EXISTS belongs_to  TYPE RELATION IN document OUT case SCHEMALESS PERMISSIONS FULL;

UPSERT form_definition:matter_intake CONTENT {
  workspace: $ws,
  title: "Matter Intake",
  slug:  "matter-intake",
  fields: [
    { key: "title",        label: "Case Title",    type: "text", required: true  },
    { key: "matter_id",    label: "Matter ID",     type: "text", required: false },
    { key: "client_name",  label: "Client Name",   type: "text", required: true  },
    { key: "client_email", label: "Client Email",  type: "text", required: true  },
    { key: "description",  label: "Description",   type: "text", required: false }
  ],
  conditional_rules: [],
  auto_relations: []
};

RELATE $ws->workspace_has_form_definition->form_definition:matter_intake;
RELATE form_definition:matter_intake->form_targets_entity_type->entity_type:case_t;

-- ─── 7b. Case + client + document sample data ─────────────────────────────────

BEGIN TRANSACTION;

LET $redwood = (UPSERT client:redwood CONTENT {
  workspace: workspace:harbor,
  name: "Redwood Group",
  email: "legal@redwood.example.com"
} RETURN id)[0].id;

LET $triton = (UPSERT client:triton CONTENT {
  workspace: workspace:harbor,
  name: "Triton Corp",
  email: "counsel@triton.example.com"
} RETURN id)[0].id;

LET $case1 = (UPSERT case:redwood_v_triton CONTENT {
  workspace: workspace:harbor,
  title: "Redwood v. Triton",
  matter_id: "2026-001",
  status: "Open",
  opened_at: <datetime>"2026-01-15T00:00:00Z"
} RETURN id)[0].id;

LET $case2 = (UPSERT case:triton_v_harbor CONTENT {
  workspace: workspace:harbor,
  title: "Triton v. Harbor LLC",
  matter_id: "2026-002",
  status: "Pending",
  opened_at: <datetime>"2026-02-03T00:00:00Z"
} RETURN id)[0].id;

LET $motion = (UPSERT document:motion_42 CONTENT {
  workspace: workspace:harbor,
  title: "Motion 42 — Summary Judgment",
  doc_type: "Motion",
  filed_at: <datetime>"2026-03-20T00:00:00Z"
} RETURN id)[0].id;

RELATE $case1->assigned_to->$redwood CONTENT { workspace: workspace:harbor };
RELATE $case2->assigned_to->$triton  CONTENT { workspace: workspace:harbor };
RELATE $motion->belongs_to->$case1   CONTENT { workspace: workspace:harbor };

COMMIT TRANSACTION;

-- ─── 8. Demo mutation records (drives "Recent changes" panel) ─────────────────

UPSERT mutation:demo_mut1 CONTENT {
  command_id: "sheet.operation.set-range-values",
  params:     { range: "A12", value: "=GRAPH_TRAVERSE(\"company:acme_holdings\",\"owns\",2)" },
  client_id:  "demo-client-yc"
};

UPSERT mutation:demo_mut2 CONTENT {
  command_id: "sheet.command.insert-row",
  params:     { after: 3 },
  client_id:  "demo-client-wong"
};

UPSERT mutation:demo_mut3 CONTENT {
  command_id: "sheet.operation.set-range-values",
  params:     { range: "C5", value: "owns -> beta_llc" },
  client_id:  "demo-client-rivera"
};

RELATE workspace:harbor->workspace_has_mutation->mutation:demo_mut1;
RELATE workspace:harbor->workspace_has_mutation->mutation:demo_mut2;
RELATE workspace:harbor->workspace_has_mutation->mutation:demo_mut3;

RELATE workbook:legal_entities->workbook_has_mutation->mutation:demo_mut1;
RELATE workbook:legal_entities->workbook_has_mutation->mutation:demo_mut2;
RELATE workbook:case_ops->workbook_has_mutation->mutation:demo_mut3;

RELATE mutation:demo_mut1->mutation_actor_user->app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1`;
RELATE mutation:demo_mut2->mutation_actor_user->app_user:demo_wong;
RELATE mutation:demo_mut3->mutation_actor_user->app_user:demo_rivera;
