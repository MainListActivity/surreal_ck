-- Case Management template provisioning script.
-- Idempotent: safe to re-run on an existing workspace.
--
-- Variables injected by the client before execution:
--   $ws     -- record<workspace>
--   $wb     -- record<workbook>
--   $ws_key -- string  workspace nanoid prefix, e.g. "k3f8x2"
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Sheet records ─────────────────────────────────────────────────────────

LET $sheet_case = (
  UPSERT sheet:⟨case_⟩ + $ws_key CONTENT {
    workbook:    $wb,
    univer_id:   rand::ulid(),
    table_name:  "ent_" + $ws_key + "_case",
    label:       "Cases",
    position:    0,
    column_defs: [
      { key: "title",     label: "Case Title", field_type: "text",          required: true  },
      { key: "matter_id", label: "Matter ID",  field_type: "text",          required: false },
      { key: "status",    label: "Status",     field_type: "single_select", required: false,
        options: ["Open", "Pending", "Closed"] },
      { key: "opened_at", label: "Opened",     field_type: "date",          required: false }
    ]
  } RETURN id
)[0].id;

LET $sheet_client = (
  UPSERT sheet:⟨client_⟩ + $ws_key CONTENT {
    workbook:    $wb,
    univer_id:   rand::ulid(),
    table_name:  "ent_" + $ws_key + "_client",
    label:       "Clients",
    position:    1,
    column_defs: [
      { key: "name",  label: "Client Name", field_type: "text", required: true  },
      { key: "email", label: "Email",       field_type: "text", required: false },
      { key: "phone", label: "Phone",       field_type: "text", required: false }
    ]
  } RETURN id
)[0].id;

LET $sheet_document = (
  UPSERT sheet:⟨document_⟩ + $ws_key CONTENT {
    workbook:    $wb,
    univer_id:   rand::ulid(),
    table_name:  "ent_" + $ws_key + "_document",
    label:       "Documents",
    position:    2,
    column_defs: [
      { key: "title",    label: "Document Title", field_type: "text",          required: true  },
      { key: "doc_type", label: "Type",           field_type: "single_select", required: false,
        options: ["Motion", "Brief", "Order", "Contract", "Evidence"] },
      { key: "filed_at", label: "Filed",          field_type: "date",          required: false }
    ]
  } RETURN id
)[0].id;

RELATE $wb->workbook_has_sheet->$sheet_case;
RELATE $wb->workbook_has_sheet->$sheet_client;
RELATE $wb->workbook_has_sheet->$sheet_document;

-- ─── 2. Edge catalog ──────────────────────────────────────────────────────────

UPSERT edge_catalog:⟨assigned_to_⟩ + $ws_key CONTENT {
  workspace:  $ws,
  key:        "assigned_to",
  label:      "Assigned To",
  rel_table:  "rel_" + $ws_key + "_assigned_to",
  from_table: "ent_" + $ws_key + "_case",
  to_table:   "ent_" + $ws_key + "_client",
  edge_props: []
};

UPSERT edge_catalog:⟨filed_in_⟩ + $ws_key CONTENT {
  workspace:  $ws,
  key:        "filed_in",
  label:      "Filed In",
  rel_table:  "rel_" + $ws_key + "_filed_in",
  from_table: "ent_" + $ws_key + "_case",
  to_table:   "ent_" + $ws_key + "_case",
  edge_props: []
};

UPSERT edge_catalog:⟨belongs_to_⟩ + $ws_key CONTENT {
  workspace:  $ws,
  key:        "belongs_to",
  label:      "Belongs To",
  rel_table:  "rel_" + $ws_key + "_belongs_to",
  from_table: "ent_" + $ws_key + "_document",
  to_table:   "ent_" + $ws_key + "_case",
  edge_props: []
};

-- ─── 3. Dynamic DDL ───────────────────────────────────────────────────────────

LET $tbl_case       = "ent_" + $ws_key + "_case";
LET $tbl_client     = "ent_" + $ws_key + "_client";
LET $tbl_document   = "ent_" + $ws_key + "_document";
LET $rel_assigned   = "rel_" + $ws_key + "_assigned_to";
LET $rel_filed_in   = "rel_" + $ws_key + "_filed_in";
LET $rel_belongs_to = "rel_" + $ws_key + "_belongs_to";

DEFINE TABLE IF NOT EXISTS type::table($tbl_case) SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE type::table($tbl_case) TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($tbl_case) TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE type::table($tbl_case) TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE type::table($tbl_case) COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS type::table($tbl_client) SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE type::table($tbl_client) TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($tbl_client) TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE type::table($tbl_client) TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE type::table($tbl_client) COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS type::table($tbl_document) SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE type::table($tbl_document) TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($tbl_document) TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE type::table($tbl_document) TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS idx_workspace ON TABLE type::table($tbl_document) COLUMNS workspace;

DEFINE TABLE IF NOT EXISTS type::table($rel_assigned) TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($rel_assigned) TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS type::table($rel_filed_in) TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($rel_filed_in) TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS type::table($rel_belongs_to) TYPE RELATION SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE type::table($rel_belongs_to) TYPE datetime VALUE time::now();

-- ─── 4. Form definition ───────────────────────────────────────────────────────

UPSERT form_definition:⟨matter_intake_⟩ + $ws_key CONTENT {
  workspace:    $ws,
  title:        "Matter Intake",
  slug:         "matter-intake",
  target_sheet: $sheet_case,
  fields: [
    { key: "title",        label: "Case Title",    field_type: "text", required: true  },
    { key: "matter_id",    label: "Matter ID",     field_type: "text", required: false },
    { key: "client_name",  label: "Client Name",   field_type: "text", required: true  },
    { key: "client_email", label: "Client Email",  field_type: "text", required: true  },
    { key: "description",  label: "Description",   field_type: "text", required: false }
  ],
  conditional_rules: [],
  auto_edges: []
};

-- ─── 5. Sample data ───────────────────────────────────────────────────────────

BEGIN TRANSACTION;

LET $redwood = (CREATE type::table($tbl_client) CONTENT {
  workspace: $ws,
  name:      "Redwood Group",
  email:     "legal@redwood.example.com"
} RETURN id)[0].id;

LET $triton = (CREATE type::table($tbl_client) CONTENT {
  workspace: $ws,
  name:      "Triton Corp",
  email:     "counsel@triton.example.com"
} RETURN id)[0].id;

LET $case1 = (CREATE type::table($tbl_case) CONTENT {
  workspace:  $ws,
  title:      "Redwood v. Triton",
  matter_id:  "2026-001",
  status:     "Open",
  opened_at:  time::now()
} RETURN id)[0].id;

LET $case2 = (CREATE type::table($tbl_case) CONTENT {
  workspace:  $ws,
  title:      "Triton v. Harbor LLC",
  matter_id:  "2026-002",
  status:     "Pending",
  opened_at:  time::now()
} RETURN id)[0].id;

LET $motion = (CREATE type::table($tbl_document) CONTENT {
  workspace:  $ws,
  title:      "Motion 42 — Summary Judgment",
  doc_type:   "Motion",
  filed_at:   time::now()
} RETURN id)[0].id;

RELATE $case1->type::table($rel_assigned)->$redwood;
RELATE $case2->type::table($rel_assigned)->$triton;
RELATE $motion->type::table($rel_belongs_to)->$case1;

COMMIT TRANSACTION;
