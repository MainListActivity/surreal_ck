-- demo.surql — Harbor Legal Ops demo seed
-- Idempotent: safe to re-run. All statements use UPSERT / IF NOT EXISTS.
-- Run after main.surql. Does NOT call the template scripts — it inlines
-- equivalent DDL so it is self-contained and can be imported in one pass.
-- Assumes NS main DB docs.
--
-- Contents:
--   1. Demo users
--   2. Workspace + workbooks + structural edges
--   3. Workspace members + member_identifies_user edges
--   4. Legal Entity Tracker workbook: sheets, edge catalog, DDL, form, data
--   5. Case Management workbook: sheets, edge catalog, DDL, form, data
--   6. Three demo mutation records

USE NS main DB docs;

-- ws_key for this demo workspace: "harbor"
-- Entity table prefix:   ent_harbor_{entity}
-- Relation table prefix: rel_harbor_{relation}

-- ─── 1. Demo users ────────────────────────────────────────────────────────────

UPSERT app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1` CONTENT {
  subject:      "demo|yc-chen",
  email:        "yc@harbor-legal.example.com",
  display_name: "YC Chen"
};

UPSERT app_user:demo_wong CONTENT {
  subject:      "demo|a-wong",
  email:        "awong@harbor-legal.example.com",
  display_name: "A. Wong"
};

UPSERT app_user:demo_rivera CONTENT {
  subject:      "demo|m-rivera",
  email:        "mrivera@harbor-legal.example.com",
  display_name: "M. Rivera"
};

UPSERT app_user:demo_guest CONTENT {
  subject:      "demo|guest",
  email:        "guest@harbor-legal.example.com",
  display_name: "Guest Viewer"
};

-- ─── 2. Workspace + workbooks ─────────────────────────────────────────────────

UPSERT workspace:harbor CONTENT {
  name: "Harbor Legal Ops",
  slug: "harbor-legal-ops"
};

UPSERT workbook:legal_entities CONTENT {
  workspace:    workspace:harbor,
  name:         "Legal Entity Tracker",
  template_key: "legal-entity-tracker"
};

UPSERT workbook:case_ops CONTENT {
  workspace:    workspace:harbor,
  name:         "Case Management",
  template_key: "case-management"
};

RELATE app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1`->owns_workspace->workspace:harbor;
RELATE workspace:harbor->workspace_has_workbook->workbook:legal_entities;
RELATE workspace:harbor->workspace_has_workbook->workbook:case_ops;

-- ─── 3. Workspace members ─────────────────────────────────────────────────────

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

RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_yc;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_wong;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_rivera;
RELATE workspace:harbor->workspace_has_member->workspace_member:harbor_guest;

RELATE workspace_member:harbor_yc->member_identifies_user->app_user:`a7edfa07-6852-4f17-aa18-d9ce760041e1`;
RELATE workspace_member:harbor_wong->member_identifies_user->app_user:demo_wong;
RELATE workspace_member:harbor_rivera->member_identifies_user->app_user:demo_rivera;
RELATE workspace_member:harbor_guest->member_identifies_user->app_user:demo_guest;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. LEGAL ENTITY TRACKER WORKBOOK
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Sheets ───────────────────────────────────────────────────────────────────

UPSERT sheet:company_harbor CONTENT {
  workbook:    workbook:legal_entities,
  univer_id:   "uni-harbor-company",
  table_name:  "ent_harbor_company",
  label:       "Companies",
  position:    0,
  column_defs: [
    { key: "name",         label: "Name",         field_type: "text",          required: true  },
    { key: "jurisdiction", label: "Jurisdiction", field_type: "text",          required: false },
    { key: "status",       label: "Status",       field_type: "single_select", required: false,
      options: ["Active", "Dissolved", "Pending"] }
  ]
};

UPSERT sheet:person_harbor CONTENT {
  workbook:    workbook:legal_entities,
  univer_id:   "uni-harbor-person",
  table_name:  "ent_harbor_person",
  label:       "People",
  position:    1,
  column_defs: [
    { key: "name",  label: "Full Name", field_type: "text", required: true  },
    { key: "email", label: "Email",     field_type: "text", required: false },
    { key: "role",  label: "Role",      field_type: "text", required: false }
  ]
};

UPSERT sheet:trust_harbor CONTENT {
  workbook:    workbook:legal_entities,
  univer_id:   "uni-harbor-trust",
  table_name:  "ent_harbor_trust",
  label:       "Trusts",
  position:    2,
  column_defs: [
    { key: "name",       label: "Trust Name",   field_type: "text", required: true  },
    { key: "trustee",    label: "Trustee",      field_type: "text", required: false },
    { key: "settled_at", label: "Settled Date", field_type: "date", required: false }
  ]
};

RELATE workbook:legal_entities->workbook_has_sheet->sheet:company_harbor;
RELATE workbook:legal_entities->workbook_has_sheet->sheet:person_harbor;
RELATE workbook:legal_entities->workbook_has_sheet->sheet:trust_harbor;

-- ─── Edge catalog ─────────────────────────────────────────────────────────────

UPSERT edge_catalog:owns_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "owns",
  label:      "Owns",
  rel_table:  "rel_harbor_owns",
  from_table: "ent_harbor_company",
  to_table:   "ent_harbor_company",
  edge_props: [
    { key: "ownership_pct", label: "Ownership %", field_type: "decimal" }
  ]
};

UPSERT edge_catalog:controls_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "controls",
  label:      "Controls",
  rel_table:  "rel_harbor_controls",
  from_table: "ent_harbor_company",
  to_table:   "ent_harbor_company",
  edge_props: []
};

UPSERT edge_catalog:filed_by_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "filed_by",
  label:      "Filed By",
  rel_table:  "rel_harbor_filed_by",
  from_table: "ent_harbor_company",
  to_table:   "ent_harbor_person",
  edge_props: []
};

-- ─── DDL: entity tables ───────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS ent_harbor_company SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_company TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_company TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_company TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_company_ws ON TABLE ent_harbor_company COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS ent_harbor_person SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_person TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_person TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_person TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_person_ws ON TABLE ent_harbor_person COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS ent_harbor_trust SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_trust TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_trust TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_trust TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_trust_ws ON TABLE ent_harbor_trust COLUMNS workspace;

-- ─── DDL: relation tables ─────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS rel_harbor_owns TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_owns TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS rel_harbor_controls TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_controls TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS rel_harbor_filed_by TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_filed_by TYPE datetime VALUE time::now();

-- ─── Form definition ──────────────────────────────────────────────────────────

UPSERT form_definition:new_client_intake CONTENT {
  workspace:    workspace:harbor,
  title:        "New Client Intake",
  slug:         "new-client-intake",
  target_sheet: sheet:company_harbor,
  fields: [
    { key: "name",          label: "Company Name",  field_type: "text", required: true  },
    { key: "jurisdiction",  label: "Jurisdiction",  field_type: "text", required: false },
    { key: "contact_name",  label: "Contact Name",  field_type: "text", required: true  },
    { key: "contact_email", label: "Contact Email", field_type: "text", required: true  },
    { key: "notes",         label: "Notes",         field_type: "text", required: false }
  ],
  conditional_rules: [],
  auto_edges: []
};

-- ─── Sample data ──────────────────────────────────────────────────────────────

BEGIN TRANSACTION;

LET $acme = (UPSERT ent_harbor_company:acme_holdings CONTENT {
  workspace: workspace:harbor, name: "Acme Holdings", jurisdiction: "Delaware", status: "Active"
} RETURN id)[0].id;

LET $beta = (UPSERT ent_harbor_company:beta_llc CONTENT {
  workspace: workspace:harbor, name: "Beta LLC", jurisdiction: "Hong Kong", status: "Active"
} RETURN id)[0].id;

LET $gamma = (UPSERT ent_harbor_company:gamma_inc CONTENT {
  workspace: workspace:harbor, name: "Gamma Inc", jurisdiction: "Singapore", status: "Pending"
} RETURN id)[0].id;

LET $chen = (UPSERT ent_harbor_person:chen_wei CONTENT {
  workspace: workspace:harbor, name: "Chen Wei", email: "chen@example.com", role: "Director"
} RETURN id)[0].id;

RELATE $acme->rel_harbor_owns->$beta;
RELATE $beta->rel_harbor_controls->$gamma;
RELATE $gamma->rel_harbor_filed_by->$chen;

COMMIT TRANSACTION;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. CASE MANAGEMENT WORKBOOK
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Sheets ───────────────────────────────────────────────────────────────────

UPSERT sheet:case_harbor CONTENT {
  workbook:    workbook:case_ops,
  univer_id:   "uni-harbor-case",
  table_name:  "ent_harbor_case",
  label:       "Cases",
  position:    0,
  column_defs: [
    { key: "title",     label: "Case Title", field_type: "text",          required: true  },
    { key: "matter_id", label: "Matter ID",  field_type: "text",          required: false },
    { key: "status",    label: "Status",     field_type: "single_select", required: false,
      options: ["Open", "Pending", "Closed"] },
    { key: "opened_at", label: "Opened",     field_type: "date",          required: false }
  ]
};

UPSERT sheet:client_harbor CONTENT {
  workbook:    workbook:case_ops,
  univer_id:   "uni-harbor-client",
  table_name:  "ent_harbor_client",
  label:       "Clients",
  position:    1,
  column_defs: [
    { key: "name",  label: "Client Name", field_type: "text", required: true  },
    { key: "email", label: "Email",       field_type: "text", required: false },
    { key: "phone", label: "Phone",       field_type: "text", required: false }
  ]
};

UPSERT sheet:document_harbor CONTENT {
  workbook:    workbook:case_ops,
  univer_id:   "uni-harbor-document",
  table_name:  "ent_harbor_document",
  label:       "Documents",
  position:    2,
  column_defs: [
    { key: "title",    label: "Document Title", field_type: "text",          required: true  },
    { key: "doc_type", label: "Type",           field_type: "single_select", required: false,
      options: ["Motion", "Brief", "Order", "Contract", "Evidence"] },
    { key: "filed_at", label: "Filed",          field_type: "date",          required: false }
  ]
};

RELATE workbook:case_ops->workbook_has_sheet->sheet:case_harbor;
RELATE workbook:case_ops->workbook_has_sheet->sheet:client_harbor;
RELATE workbook:case_ops->workbook_has_sheet->sheet:document_harbor;

-- ─── Edge catalog ─────────────────────────────────────────────────────────────

UPSERT edge_catalog:assigned_to_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "assigned_to",
  label:      "Assigned To",
  rel_table:  "rel_harbor_assigned_to",
  from_table: "ent_harbor_case",
  to_table:   "ent_harbor_client",
  edge_props: []
};

UPSERT edge_catalog:filed_in_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "filed_in",
  label:      "Filed In",
  rel_table:  "rel_harbor_filed_in",
  from_table: "ent_harbor_case",
  to_table:   "ent_harbor_case",
  edge_props: []
};

UPSERT edge_catalog:belongs_to_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "belongs_to",
  label:      "Belongs To",
  rel_table:  "rel_harbor_belongs_to",
  from_table: "ent_harbor_document",
  to_table:   "ent_harbor_case",
  edge_props: []
};

-- ─── DDL: entity tables ───────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS ent_harbor_case SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_case TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_case TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_case TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_case_ws ON TABLE ent_harbor_case COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS ent_harbor_client SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_client TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_client TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_client TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_client_ws ON TABLE ent_harbor_client COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS ent_harbor_document SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ent_harbor_document TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ent_harbor_document TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ent_harbor_document TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS ent_harbor_document_ws ON TABLE ent_harbor_document COLUMNS workspace;

-- ─── DDL: relation tables ─────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS rel_harbor_assigned_to TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_assigned_to TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS rel_harbor_filed_in TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_filed_in TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS rel_harbor_belongs_to TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE rel_harbor_belongs_to TYPE datetime VALUE time::now();

-- ─── Form definition ──────────────────────────────────────────────────────────

UPSERT form_definition:matter_intake CONTENT {
  workspace:    workspace:harbor,
  title:        "Matter Intake",
  slug:         "matter-intake",
  target_sheet: sheet:case_harbor,
  fields: [
    { key: "title",        label: "Case Title",   field_type: "text", required: true  },
    { key: "matter_id",    label: "Matter ID",    field_type: "text", required: false },
    { key: "client_name",  label: "Client Name",  field_type: "text", required: true  },
    { key: "client_email", label: "Client Email", field_type: "text", required: true  },
    { key: "description",  label: "Description",  field_type: "text", required: false }
  ],
  conditional_rules: [],
  auto_edges: []
};

-- ─── Sample data ──────────────────────────────────────────────────────────────

BEGIN TRANSACTION;

LET $redwood = (UPSERT ent_harbor_client:redwood CONTENT {
  workspace: workspace:harbor, name: "Redwood Group", email: "legal@redwood.example.com"
} RETURN id)[0].id;

LET $triton = (UPSERT ent_harbor_client:triton CONTENT {
  workspace: workspace:harbor, name: "Triton Corp", email: "counsel@triton.example.com"
} RETURN id)[0].id;

LET $case1 = (UPSERT ent_harbor_case:redwood_v_triton CONTENT {
  workspace: workspace:harbor, title: "Redwood v. Triton",
  matter_id: "2026-001", status: "Open",
  opened_at: <datetime>"2026-01-15T00:00:00Z"
} RETURN id)[0].id;

LET $case2 = (UPSERT ent_harbor_case:triton_v_harbor CONTENT {
  workspace: workspace:harbor, title: "Triton v. Harbor LLC",
  matter_id: "2026-002", status: "Pending",
  opened_at: <datetime>"2026-02-03T00:00:00Z"
} RETURN id)[0].id;

LET $motion = (UPSERT ent_harbor_document:motion_42 CONTENT {
  workspace: workspace:harbor, title: "Motion 42 — Summary Judgment",
  doc_type: "Motion", filed_at: <datetime>"2026-03-20T00:00:00Z"
} RETURN id)[0].id;

RELATE $case1->rel_harbor_assigned_to->$redwood;
RELATE $case2->rel_harbor_assigned_to->$triton;
RELATE $motion->rel_harbor_belongs_to->$case1;

COMMIT TRANSACTION;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Demo mutation records (drives "Recent Changes" sidebar)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Layout mutations only. Cell value writes go directly to entity tables, not here.
UPSERT mutation:demo_mut1 CONTENT {
  workbook:   workbook:legal_entities,
  command_id: "sheet.command.set-col-width",
  params:     { unitId: "uni-harbor-company", subUnitId: "uni-harbor-company", col: 0, width: 240 },
  client_id:  "demo-client-yc"
};

UPSERT mutation:demo_mut2 CONTENT {
  workbook:   workbook:legal_entities,
  command_id: "sheet.command.set-style",
  params:     { unitId: "uni-harbor-company", subUnitId: "uni-harbor-company",
                range: { startRow: 0, endRow: 0, startCol: 0, endCol: 2 },
                style: { bl: 1, fs: 12 } },
  client_id:  "demo-client-wong"
};

UPSERT mutation:demo_mut3 CONTENT {
  workbook:   workbook:legal_entities,
  command_id: "sheet.command.set-formula",
  params:     { unitId: "uni-harbor-company", subUnitId: "uni-harbor-company",
                row: 1, col: 3,
                formula: "=GRAPH_TRAVERSE(A2,\"owns\",3)" },
  client_id:  "demo-client-yc"
};
