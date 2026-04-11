OPTION IMPORT;

DEFINE NAMESPACE IF NOT EXISTS main;
USE NS main DB docs;

-- ═══════════════════════════════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- app_user is created automatically on first JWT signin (see DEFINE ACCESS below).
-- Users may read and update their own record only. No self-creation via DML.
DEFINE TABLE IF NOT EXISTS app_user SCHEMAFULL
  PERMISSIONS
    FOR select, update WHERE id = $auth,
    FOR create, delete NONE;
DEFINE FIELD IF NOT EXISTS subject      ON TABLE app_user TYPE string;
DEFINE FIELD IF NOT EXISTS email        ON TABLE app_user TYPE option<string>
  ASSERT $value = NONE OR string::is_email($value);
DEFINE FIELD IF NOT EXISTS name         ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS avatar       ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at   ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at   ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS app_user_subject_unique ON TABLE app_user COLUMNS subject UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- WORKSPACE
-- A workspace is the top-level tenant boundary. One law firm / team = one workspace.
-- Owner:  $auth->owns_workspace->workspace
-- Member: workspace->workspace_has_member->workspace_member->member_identifies_user->$auth
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      id IN $auth->owns_workspace->workspace
      OR id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update WHERE id IN $auth->owns_workspace->workspace,
    FOR delete WHERE id IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS name       ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS slug       ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;

-- workspace_member: one row per invited person.
-- Linked to an app_user via member_identifies_user once they sign in.
DEFINE TABLE IF NOT EXISTS workspace_member SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR id IN $auth<-member_identifies_user<-workspace_member,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE workspace_member TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS email      ON TABLE workspace_member TYPE string
  ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS role       ON TABLE workspace_member TYPE string
  ASSERT $value INSIDE ["admin", "editor", "viewer"];
DEFINE FIELD IF NOT EXISTS invited_at ON TABLE workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_member_email_unique
  ON TABLE workspace_member COLUMNS workspace, email UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- WORKBOOK
-- A workbook maps 1:1 to a Univer Workbook (unitId).
-- Workbooks belong to a workspace. Members see all workbooks in their workspace.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS workbook SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR create, update WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR (
        -- allow creation: the workbook does not yet have a graph edge at CREATE time,
        -- so we only require membership in the workspace stored on the record itself.
        workspace IN $auth->owns_workspace->workspace
      ),
    FOR delete WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook;
DEFINE FIELD IF NOT EXISTS workspace        ON TABLE workbook TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name             ON TABLE workbook TYPE string;
DEFINE FIELD IF NOT EXISTS template_key     ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_opened_sheet ON TABLE workbook TYPE option<record<sheet>>;
DEFINE FIELD IF NOT EXISTS created_at       ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at       ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_workspace ON TABLE workbook COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FOLDER
-- Hierarchical workspace-scoped folders for the "我的文档" tree.
-- A folder belongs to exactly one workspace. Parent-child relationships live in
-- folder_parent; workbook membership lives in folder_has_workbook.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS folder SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_folder->folder
      OR workspace IN $auth->owns_workspace->workspace,
    FOR delete WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_folder->folder
      OR workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace   ON TABLE folder TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name        ON TABLE folder TYPE string;
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE folder TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at  ON TABLE folder TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS folder_workspace ON TABLE folder COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SHEET
-- sheet is a first-class entity. One sheet = one dynamic entity table in SurrealDB.
-- Sheet stores:
--   univer_id     — Univer's subUnitId (the spreadsheet tab identifier)
--   table_name    — the actual SurrealDB table that holds this sheet's rows
--                   naming convention: ent_{workspace_nanoid}_{user_key}
--                   e.g. ent_k3f8x2_company
--   column_defs   — the authoritative column schema for the sheet
--                   (what Univer renders as columns, what forms use as fields)
--
-- sheet is the ONLY source of truth for column definitions.
-- entity_type_catalog is a separate read-only template registry (see below).
--
-- Permissions: same as workbook — workspace owner + members can read,
-- only owner can write.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS sheet SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook->workbook_has_sheet->sheet
      OR id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook->workbook_has_sheet->sheet,
    FOR create, update WHERE
      workbook.workspace IN $auth->owns_workspace->workspace,
    FOR delete WHERE
      id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook->workbook_has_sheet->sheet;

-- The workbook this sheet belongs to.
DEFINE FIELD IF NOT EXISTS workbook     ON TABLE sheet TYPE record<workbook>;
-- Univer subUnitId — stable for the lifetime of the sheet.
DEFINE FIELD IF NOT EXISTS univer_id    ON TABLE sheet TYPE string;
-- The physical SurrealDB table name that stores rows for this sheet.
-- Set once at creation, never changed. Format: ent_{ws_nanoid}_{key}
DEFINE FIELD IF NOT EXISTS table_name   ON TABLE sheet TYPE string;
-- Human-visible tab label (can be renamed without affecting table_name).
DEFINE FIELD IF NOT EXISTS label        ON TABLE sheet TYPE string;
-- Display order of the tab in Univer.
DEFINE FIELD IF NOT EXISTS position     ON TABLE sheet TYPE int DEFAULT 0;
-- The authoritative column definitions for this sheet.
-- Each element: { key, label, field_type, required, options?, relation_target_table? }
-- field_type values: "text" | "number" | "decimal" | "date" | "datetime" |
--                    "single_select" | "multi_select" | "file" | "relation"
-- relation columns point to another sheet's table_name via relation_target_table.
DEFINE FIELD IF NOT EXISTS column_defs  ON TABLE sheet TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at   ON TABLE sheet TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at   ON TABLE sheet TYPE datetime VALUE time::now();

DEFINE INDEX IF NOT EXISTS sheet_univer_id  ON TABLE sheet COLUMNS univer_id UNIQUE;
DEFINE INDEX IF NOT EXISTS sheet_table_name ON TABLE sheet COLUMNS table_name UNIQUE;
DEFINE INDEX IF NOT EXISTS sheet_workbook   ON TABLE sheet COLUMNS workbook;

-- ═══════════════════════════════════════════════════════════════════════════════
-- EDGE CATALOG
-- Workspace-level registry of named relationship types.
-- One row = one edge type that can exist in this workspace.
--
-- Consumers:
--   (a) Right-click "Create Relationship" menu — filters catalog by from_table
--       to show only edges valid for the selected row's sheet
--   (b) GRAPH_TRAVERSE / GRAPH_AGGREGATE formula autocomplete — lists rel_table
--       values as valid second argument
--   (c) Graph visualizer — uses label to render edge names
--   (d) Admin UI — CRUD for relationship types
--
-- The physical relation table (rel_{ws_key}_{key}) is created by DDL at the
-- same time as this catalog row. rel_table stores the exact table name so the
-- frontend never has to reconstruct it from conventions.
--
-- from_table / to_table constrain which entity tables may appear on each end.
-- NONE means unconstrained. These are table name strings (not sheet records)
-- so the constraint holds across workbooks that share the same entity tables.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS edge_catalog SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace   ON TABLE edge_catalog TYPE record<workspace>;
-- Short user-chosen key, unique within the workspace. e.g. "owns", "filed_by"
-- Used in GRAPH_TRAVERSE formula: =GRAPH_TRAVERSE(id, "owns", 3)
DEFINE FIELD IF NOT EXISTS key         ON TABLE edge_catalog TYPE string;
-- Display label shown in UI menus and graph visualizer. e.g. "Owns", "Filed By"
DEFINE FIELD IF NOT EXISTS label       ON TABLE edge_catalog TYPE string;
-- The exact physical SurrealDB table name for this edge. e.g. "rel_harbor_owns"
-- Frontend uses this directly in: RELATE $source->type::table($rel_table)->$target
DEFINE FIELD IF NOT EXISTS rel_table   ON TABLE edge_catalog TYPE string;
-- Physical entity table name allowed as the edge source. NONE = any table.
-- e.g. "ent_harbor_company"
DEFINE FIELD IF NOT EXISTS from_table  ON TABLE edge_catalog TYPE option<string>;
-- Physical entity table name allowed as the edge target. NONE = any table.
DEFINE FIELD IF NOT EXISTS to_table    ON TABLE edge_catalog TYPE option<string>;
-- Additional properties that live on the edge record itself (beyond created_at).
-- Rendered as extra fields in the "Create Relationship" form.
-- e.g. [{ key: "ownership_pct", label: "Ownership %", field_type: "decimal" }]
DEFINE FIELD IF NOT EXISTS edge_props  ON TABLE edge_catalog TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE edge_catalog TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS edge_catalog_ws_key_unique
  ON TABLE edge_catalog COLUMNS workspace, key UNIQUE;
DEFINE INDEX IF NOT EXISTS edge_catalog_ws_rel_table_unique
  ON TABLE edge_catalog COLUMNS workspace, rel_table UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COLLABORATION: MUTATION + SNAPSHOT
--
-- Business data (entity rows) lives in physical entity tables and is the source
-- of truth for cell values. Univer reads rows from those tables on load and on
-- LIVE SELECT updates; it does not own the values.
--
-- What Univer DOES own — and what the collab engine must persist:
--   • Column widths, row heights
--   • Cell styles (font, color, border, number format)
--   • Merged cell ranges
--   • Frozen rows / columns
--   • Formula strings (e.g. =GRAPH_TRAVERSE(...)) — the expression, not the result
--   • Row display order per sheet (record IDs sorted by user drag-and-drop)
--
-- mutation: append-only log of Univer layout commands.
--   Layout-only commands are replayed by the collab engine.
--   Commands that write cell values (set-range-values) are intercepted by the
--   collab plugin and written to the entity table instead; they are NOT stored
--   here as mutations. Only the following command types are logged:
--     sheet.command.set-col-width
--     sheet.command.set-row-height
--     sheet.command.set-style
--     sheet.command.add-merge / remove-merge
--     sheet.command.set-freeze
--     sheet.command.move-rows (reorder)
--     sheet.command.set-formula  (formula string, not value)
--
-- snapshot: periodic checkpoint of the full Univer layout state for the workbook.
--   Written by the coordinator client. Used for:
--     (a) New member initial load (avoids replaying every mutation from t=0)
--     (b) Reconnect resync when mutation log has been pruned
--   Does NOT contain cell values — those are fetched from entity tables.
--   Contains row_order per sheet so the client knows which DB record maps to
--   which Univer row index.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS mutation SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workbook IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR workbook IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR create WHERE
      workbook IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR workbook IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workbook    ON TABLE mutation TYPE record<workbook>;
-- Univer layout command ID. Only whitelisted layout commands are stored here.
DEFINE FIELD IF NOT EXISTS command_id  ON TABLE mutation TYPE string;
-- Exact Univer command params as emitted by onCommandExecuted.
DEFINE FIELD OVERWRITE params      ON TABLE mutation TYPE object FLEXIBLE;
-- Stable per-tab client identifier (generated once, stored in localStorage).
DEFINE FIELD IF NOT EXISTS client_id   ON TABLE mutation TYPE string;
-- Server-assigned. Authoritative timestamp for last-write-wins on layout conflicts.
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mutation_workbook_ts ON TABLE mutation COLUMNS workbook, created_at;

DEFINE TABLE IF NOT EXISTS snapshot SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workbook IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR workbook IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR create WHERE
      workbook IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR workbook IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workbook              ON TABLE snapshot TYPE record<workbook>;
-- Layout-only checkpoint. Structure:
-- {
--   sheets: {
--     [univer_sub_unit_id]: {
--       columnWidths:  { [colIndex]: widthPx },
--       rowHeights:    { [rowIndex]: heightPx },
--       merges:        [{ startRow, endRow, startCol, endCol }],
--       freeze:        { xSplit, ySplit },
--       styles:        { [cellRef]: { ... } },
--       formulas:      { [cellRef]: "=GRAPH_TRAVERSE(...)" },
--       row_order:     ["ent_harbor_company:acme_holdings", "ent_harbor_company:beta_llc", ...]
--     }
--   }
-- }
-- row_order is an ordered array of SurrealDB record IDs. Index 0 = Univer row 0.
-- It is the binding between the DB world and the Univer row index world.
-- Cell values are NOT included — they are always fetched live from entity tables.
DEFINE FIELD IF NOT EXISTS layout                ON TABLE snapshot TYPE object;
-- client_id of the coordinator that wrote this snapshot.
DEFINE FIELD IF NOT EXISTS coordinator_client_id ON TABLE snapshot TYPE string;
-- created_at of the last mutation captured in this snapshot.
-- Clients replay only mutations with created_at > this watermark.
DEFINE FIELD IF NOT EXISTS mutation_watermark    ON TABLE snapshot TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at            ON TABLE snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS snapshot_workbook_ts  ON TABLE snapshot COLUMNS workbook, created_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PRESENCE
-- One record per live browser tab. Expires after TTL (client heartbeat refreshes it).
-- Used to elect the snapshot coordinator (lowest client_id = coordinator).
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS presence SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workbook IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR workbook IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR create, update, delete WHERE $auth != NONE;
DEFINE FIELD IF NOT EXISTS workbook   ON TABLE presence TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS client_id  ON TABLE presence TYPE string;
-- Cursor position for collaborative awareness (Univer sheet + cell reference).
DEFINE FIELD IF NOT EXISTS cursor     ON TABLE presence TYPE option<object>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE presence TYPE datetime;
DEFINE INDEX IF NOT EXISTS presence_client_id ON TABLE presence COLUMNS client_id UNIQUE;
DEFINE INDEX IF NOT EXISTS presence_workbook  ON TABLE presence COLUMNS workbook;

-- ═══════════════════════════════════════════════════════════════════════════════
-- INTAKE FORMS
-- form_definition describes a public intake form: fields, conditional logic,
-- which sheet rows it creates, and how it auto-links them with graph edges.
--
-- target_sheet  — the sheet whose table receives the new entity row.
-- auto_edges    — list of edges to create automatically on submit,
--                 e.g. link the new company to an existing company via "owns".
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS form_definition SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace   ON TABLE form_definition TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title       ON TABLE form_definition TYPE string;
-- URL-safe slug used in the public form URL: /f/{slug}
DEFINE FIELD IF NOT EXISTS slug        ON TABLE form_definition TYPE string;
-- The sheet that receives new entity rows on submission.
DEFINE FIELD IF NOT EXISTS target_sheet ON TABLE form_definition TYPE record<sheet>;
-- Field definitions for the form UI. Each element mirrors a column_def but
-- may include form-specific presentation (help_text, placeholder, etc.).
-- { key, label, field_type, required, options?, help_text?, placeholder? }
DEFINE FIELD IF NOT EXISTS fields      ON TABLE form_definition TYPE array<object> DEFAULT [];
-- Conditional visibility rules: [{ if_field, equals, then_show: [field_keys] }]
DEFINE FIELD IF NOT EXISTS conditional_rules ON TABLE form_definition TYPE array<object> DEFAULT [];
-- Automatic graph edges to create on submission.
-- Each element: { edge_key, direction: "out"|"in", match_field, match_target_table }
-- e.g. automatically RELATE new_company->owns->existing_company when submitted.
DEFINE FIELD IF NOT EXISTS auto_edges  ON TABLE form_definition TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at  ON TABLE form_definition TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS form_definition_workspace_slug_unique
  ON TABLE form_definition COLUMNS workspace, slug UNIQUE;

-- intake_submission: the raw payload captured when a public form is submitted.
-- Immutable after creation. workspace members can read; any authed session may create.
DEFINE TABLE IF NOT EXISTS intake_submission SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workspace        ON TABLE intake_submission TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS form             ON TABLE intake_submission TYPE record<form_definition>;
-- The entity row created by this submission (populated after processing).
DEFINE FIELD IF NOT EXISTS created_record   ON TABLE intake_submission TYPE option<string>;
-- The raw submitted payload before field mapping is applied.
DEFINE FIELD IF NOT EXISTS payload          ON TABLE intake_submission TYPE object;
-- true if the Cloudflare Turnstile check was bypassed due to API timeout.
DEFINE FIELD IF NOT EXISTS unverified       ON TABLE intake_submission TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at       ON TABLE intake_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS intake_submission_workspace ON TABLE intake_submission COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FILES
-- workbook_file: metadata record for a file stored in the spreadsheet_files bucket.
-- The bucket holds the binary. This table holds the metadata and access control.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS workbook_file SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE
      workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS workspace      ON TABLE workbook_file TYPE record<workspace>;
-- The entity row this file is attached to (table:id string, e.g. "ent_k3f8x2_company:acme").
DEFINE FIELD IF NOT EXISTS attached_to    ON TABLE workbook_file TYPE option<string>;
DEFINE FIELD IF NOT EXISTS bucket_path    ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS original_name  ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS mime_type      ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS size_bytes     ON TABLE workbook_file TYPE int;
DEFINE FIELD IF NOT EXISTS uploaded_by    ON TABLE workbook_file TYPE record<app_user>;
DEFINE FIELD IF NOT EXISTS created_at     ON TABLE workbook_file TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_file_workspace ON TABLE workbook_file COLUMNS workspace;

-- ═══════════════════════════════════════════════════════════════════════════════
-- OBSERVABILITY
-- client_error: append-only error log written by the JS client.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      workspace IN $auth->owns_workspace->workspace
      OR workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create WHERE $auth != NONE,
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS workspace  ON TABLE client_error TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS workbook   ON TABLE client_error TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS client_id  ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS message    ON TABLE client_error TYPE string;
-- Truncated stack trace (max 2 KB).
DEFINE FIELD IF NOT EXISTS stack      ON TABLE client_error TYPE option<string>;
-- Contextual metadata (e.g. { command_id, sheet_id }).
DEFINE FIELD IF NOT EXISTS meta       ON TABLE client_error TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE client_error TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS client_error_ts ON TABLE client_error COLUMNS created_at;

-- ═══════════════════════════════════════════════════════════════════════════════
-- GRAPH EDGES (system relations — workspace, workbook, sheet hierarchy)
-- ═══════════════════════════════════════════════════════════════════════════════

-- owns_workspace: the founding edge that marks a user as workspace owner.
-- Created once when the workspace is created. Never updated.
DEFINE TABLE IF NOT EXISTS owns_workspace TYPE RELATION IN app_user OUT workspace SCHEMAFULL
  PERMISSIONS
    FOR select, create, update, delete WHERE in = $auth;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE owns_workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS owns_workspace_unique ON TABLE owns_workspace COLUMNS in, out UNIQUE;

-- workspace_has_member: workspace → workspace_member.
DEFINE TABLE IF NOT EXISTS workspace_has_member TYPE RELATION IN workspace OUT workspace_member SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in IN $auth->owns_workspace->workspace
      OR in IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_member_unique ON TABLE workspace_has_member COLUMNS in, out UNIQUE;

-- member_identifies_user: workspace_member → app_user.
-- Created automatically during JWT signin (auto-claim logic in DEFINE ACCESS).
DEFINE TABLE IF NOT EXISTS member_identifies_user TYPE RELATION IN workspace_member OUT app_user SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      out = $auth
      OR in.workspace IN $auth->owns_workspace->workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE member_identifies_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS member_identifies_user_unique ON TABLE member_identifies_user COLUMNS in, out UNIQUE;

-- workspace_has_workbook: workspace → workbook.
DEFINE TABLE IF NOT EXISTS workspace_has_workbook TYPE RELATION IN workspace OUT workbook SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in IN $auth->owns_workspace->workspace
      OR in IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in IN $auth->owns_workspace->workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_workbook_unique ON TABLE workspace_has_workbook COLUMNS in, out UNIQUE;

-- workbook_has_sheet: workbook → sheet.
-- Created when a user adds a sheet tab. Deleted when the tab is removed.
DEFINE TABLE IF NOT EXISTS workbook_has_sheet TYPE RELATION IN workbook OUT sheet SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook
      OR in IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_workbook->workbook,
    FOR create, update, delete WHERE
      in IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_has_sheet TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_has_sheet_unique ON TABLE workbook_has_sheet COLUMNS in, out UNIQUE;

-- workspace_has_folder: workspace → folder.
DEFINE TABLE IF NOT EXISTS workspace_has_folder TYPE RELATION IN workspace OUT folder SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in IN $auth->owns_workspace->workspace
      OR in IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in IN $auth->owns_workspace->workspace
      AND out.workspace = in;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_folder TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_folder_unique ON TABLE workspace_has_folder COLUMNS in, out UNIQUE;

-- folder_parent: child folder → parent folder.
DEFINE TABLE IF NOT EXISTS folder_parent TYPE RELATION IN folder OUT folder SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS position   ON TABLE folder_parent TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE folder_parent TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS folder_parent_unique_child ON TABLE folder_parent COLUMNS in UNIQUE;

-- folder_has_workbook: folder → workbook.
DEFINE TABLE IF NOT EXISTS folder_has_workbook TYPE RELATION IN folder OUT workbook SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      in.workspace IN $auth->owns_workspace->workspace
      OR in.workspace IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace,
    FOR create, update, delete WHERE
      in.workspace IN $auth->owns_workspace->workspace
      AND in.workspace = out.workspace;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE folder_has_workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS folder_has_workbook_unique_workbook ON TABLE folder_has_workbook COLUMNS out UNIQUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FILE STORAGE BUCKET
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE BUCKET IF NOT EXISTS spreadsheet_files BACKEND "file:/data/uploads" PERMISSIONS FULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- AUTH ACCESS
-- JWT issued by the external OIDC provider (maplayer.top).
-- On first signin: creates app_user, auto-claims pending workspace_member invitations.
-- ═══════════════════════════════════════════════════════════════════════════════

DEFINE ACCESS OVERWRITE madocs ON DATABASE TYPE RECORD
  WITH JWT URL 'https://o.maplayer.top/t/ck/jwks.json'
  AUTHENTICATE {

    IF type::is_array($token.aud) AND $token.aud CONTAINS 'https://auth.maplayer.top'
      OR $token.aud = 'https://auth.maplayer.top'
    {
      IF !$token.sub { THROW 'Missing sub claim' };

      LET $user_id   = type::record('app_user', $token.sub);
      LET $existing  = (SELECT VALUE id FROM ONLY $user_id);

      IF !$existing {
        LET $display_name =
          IF $token.name               { <string>$token.name               }
          ELSE IF $token.preferred_username { <string>$token.preferred_username }
          ELSE IF $token.email         { <string>$token.email              }
          ELSE                         { <string>$token.sub                };

        CREATE $user_id CONTENT {
          display_name: $display_name,
          email:        $token.email,
          subject:      $token.sub,
          avatar:       IF $token.picture { <string>$token.picture } ELSE { NONE },
          created_at:   time::now(),
          updated_at:   time::now()
        };
      };

      -- Auto-claim: link workspace_member records that share this email
      -- but have no member_identifies_user edge yet.
      -- Runs with system privileges inside AUTHENTICATE (bypasses row-level permissions).
      IF $token.email {
        LET $unclaimed = (
          SELECT VALUE id FROM workspace_member
          WHERE email = <string>$token.email
            AND id NOT IN $user_id<-member_identifies_user<-workspace_member
        );
        FOR $member IN $unclaimed {
          RELATE $member->member_identifies_user->$user_id;
        };
      };

      RETURN $user_id;

    } ELSE {
      THROW 'not allowed'
    }

  } DURATION FOR TOKEN 1h, FOR SESSION NONE;
