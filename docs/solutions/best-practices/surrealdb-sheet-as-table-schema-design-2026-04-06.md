---
title: SurrealDB Schema Design — Sheet-as-Table Architecture with snapshot and edge_catalog
date: 2026-04-06
category: docs/solutions/best-practices
module: schema
problem_type: best_practice
component: database
severity: high
applies_when:
  - Designing the SurrealDB schema for a workbook/sheet entity model
  - Deciding what to store in the snapshot table
  - Designing the edge_catalog for a dynamic graph relation system
tags: surrealdb, schema-design, snapshot, edge-catalog, sheet, graph, surreal_ck
---

# SurrealDB Schema Design — Sheet-as-Table Architecture with snapshot and edge_catalog

## Context

The project uses SurrealDB as the only backend. Each spreadsheet "sheet" tab maps 1:1 to a physical
SurrealDB table (`ent_{ws_key}_{entity}`) that stores entity rows directly. This decision eliminates
a generic `entity` table and enables native SurrealDB graph traversal (`->rel_table->`) without any
indirection layer.

Two tables required careful redesign once the sheet-as-table architecture was confirmed:

- **snapshot** — originally intended to store a full `fWorkbook.save()` JSON blob, including cell values
- **edge_catalog** — originally referenced `sheet` records as `from_sheet`/`to_sheet` endpoints

## Guidance

### snapshot — stores Univer layout state only, never business data values

Cell values are owned by entity tables (`ent_harbor_company`, etc.) and fetched live via SurrealDB
queries and LIVE SELECT. The snapshot table must **not** duplicate them.

What snapshot **does** store:

```
layout.sheets.[univer_sub_unit_id]
  columnWidths:  { [colIndex]: widthPx }
  rowHeights:    { [rowIndex]: heightPx }
  merges:        [{ startRow, endRow, startCol, endCol }]
  freeze:        { xSplit, ySplit }
  styles:        { [cellRef]: { ... } }
  formulas:      { [cellRef]: "=GRAPH_TRAVERSE(...)" }   -- expression only, not result
  row_order:     ["ent_harbor_company:acme_holdings", "ent_harbor_company:beta_llc", ...]
```

`row_order` is the most critical field. It is an ordered array of SurrealDB record IDs that maps
each Univer row index to a specific DB record. Without it, the client cannot know which row 0
corresponds to which company after a reconnect or initial load.

Schema field is named `layout` (not `data`) to make the scope explicit:

```surql
DEFINE FIELD IF NOT EXISTS layout ON TABLE snapshot TYPE object;
```

The mutation table is also narrowed to **layout-only commands**. Commands that write cell values
(`sheet.command.set-range-values`) are intercepted by the collab plugin and written directly to
entity tables — they are not stored as mutations.

Whitelisted layout mutation command IDs:
- `sheet.command.set-col-width`
- `sheet.command.set-row-height`
- `sheet.command.set-style`
- `sheet.command.add-merge` / `sheet.command.remove-merge`
- `sheet.command.set-freeze`
- `sheet.command.move-rows`
- `sheet.command.set-formula`

### edge_catalog — uses table name strings, not sheet record references

The edge_catalog is the workspace-level registry of named relationship types. Each row represents
one edge type and its physical relation table.

**Key field: `rel_table`**

The physical SurrealDB table name for this edge (e.g. `"rel_harbor_owns"`). The frontend uses this
directly when creating a relationship:

```surql
RELATE $source->type::table($rel_table)->$target;
```

Without `rel_table`, the frontend would have to reconstruct the name from naming conventions —
fragile and coupling UI to DB internals.

**Endpoint constraints: `from_table` / `to_table` (not `from_sheet` / `to_sheet`)**

These are physical table name strings, not `record<sheet>` references. The reason:

- A workspace can have multiple workbooks, each with sheets that reference the same entity table
- Constraining to a sheet record ties the edge type to one specific workbook's sheet
- Constraining to a table name applies across all workbooks that use the same entity table

```surql
DEFINE FIELD IF NOT EXISTS rel_table  ON TABLE edge_catalog TYPE string;
DEFINE FIELD IF NOT EXISTS from_table ON TABLE edge_catalog TYPE option<string>; -- e.g. "ent_harbor_company", NONE = unconstrained
DEFINE FIELD IF NOT EXISTS to_table   ON TABLE edge_catalog TYPE option<string>;
```

The `from_table` constraint drives the "Create Relationship" right-click menu: filter
`edge_catalog WHERE from_table = <current sheet's table_name>` to show only valid edges
for the selected row's sheet.

**Full edge_catalog row example:**

```surql
UPSERT edge_catalog:owns_harbor CONTENT {
  workspace:  workspace:harbor,
  key:        "owns",             -- used in =GRAPH_TRAVERSE(A2, "owns", 3)
  label:      "Owns",             -- displayed in UI menus and graph visualizer
  rel_table:  "rel_harbor_owns",  -- used in RELATE $a->type::table($rel_table)->$b
  from_table: "ent_harbor_company",
  to_table:   "ent_harbor_company",
  edge_props: [
    { key: "ownership_pct", label: "Ownership %", field_type: "decimal" }
  ]
};
```

`edge_props` defines additional fields on the edge record itself (beyond `created_at`), rendered
as extra form fields in the "Create Relationship" dialog.

## Why This Matters

**snapshot without this boundary:**
- Business data stored in both entity tables and snapshot blob → they drift out of sync
- Reconnecting client restores stale snapshot values, overwriting live DB state
- Storage bloat: every snapshot carries a full copy of all entity data

**edge_catalog without `rel_table`:**
- Frontend reconstructs `"rel_" + ws_key + "_" + key` from naming conventions
- Any convention change breaks all relation creation silently
- No single source of truth for what physical table an edge type uses

**edge_catalog with `from_sheet` instead of `from_table`:**
- Adding a second workbook with a "Companies" sheet creates a different sheet record
- The same "owns" edge type would need a separate catalog row per workbook
- Breaks the workspace-level semantics of the catalog

## When to Apply

- Any time the snapshot table is read or written — the `layout` field contract must be respected
- When the collab plugin intercepts a Univer command — route layout commands to `mutation`, value writes to entity tables
- When building the "Create Relationship" UI — query `edge_catalog WHERE from_table = $current_table_name`
- When building GRAPH_TRAVERSE formula autocomplete — query `edge_catalog WHERE workspace = $ws` to list valid `key` values
- When provisioning a new workspace (template scripts) — create `edge_catalog` rows alongside DDL for relation tables

## Examples

### Loading a sheet on reconnect

```typescript
// 1. Fetch latest snapshot (layout only)
const snap = await db.query(
  `SELECT layout FROM snapshot WHERE workbook = $wb ORDER BY created_at DESC LIMIT 1`,
  { wb: workbookId }
);

// 2. Apply layout to Univer (column widths, styles, formulas)
applyLayout(snap.layout);

// 3. Use row_order to fetch live entity data in display order
const rowOrder = snap.layout.sheets[sheetUniverSubUnitId].row_order;
const rows = await db.query(
  `SELECT * FROM type::table($tbl) WHERE id IN $ids`,
  { tbl: sheet.table_name, ids: rowOrder }
);

// 4. Populate Univer cells with live values
populateCells(rowOrder, rows);
```

### Creating a relationship from right-click menu

```typescript
// 1. Identify the current sheet's table_name
const currentTable = currentSheet.table_name; // "ent_harbor_company"

// 2. Fetch valid edge types for this table
const edges = await db.query(
  `SELECT key, label, rel_table, edge_props
   FROM edge_catalog
   WHERE workspace = $ws AND (from_table = $tbl OR from_table = NONE)`,
  { ws: workspaceId, tbl: currentTable }
);

// 3. Show menu to user, capture selection + target record + edge_props values
const { rel_table, props } = userSelection;

// 4. Create the edge
await db.query(
  `RELATE $source->type::table($rel)->$target CONTENT $props`,
  { source: selectedRecordId, rel: rel_table, target: targetRecordId, props }
);
```

## Related

- `schema/main.surql` — canonical definitions for `snapshot` and `edge_catalog`
- `schema/demo.surql` — concrete demo data showing edge_catalog rows with all fields
- `schema/templates/legal-entity-tracker.surql` — template provisioning with edge_catalog + DDL in one pass
