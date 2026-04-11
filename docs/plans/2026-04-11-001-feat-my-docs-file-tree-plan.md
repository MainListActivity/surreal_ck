---
title: "feat: My Documents — file tree with folder hierarchy"
type: feat
status: completed
date: 2026-04-11
---

# feat: My Documents — File Tree with Folder Hierarchy

## Overview

Add a "我的文档" (My Documents) view to the home shell. The view replicates the Tencent Docs "My Cloud Doc" layout: the left rail shows an expandable folder tree for the current workspace; the right main area shows the selected folder's immediate contents (subfolders + workbooks) as a dense table. Users can create, rename, delete, and move folders, and attach/detach workbooks to folders. Workbooks that are not in any folder appear in an "未分类" (Unfiled) section.

This requires new SurrealDB schema (three new tables), a new React hook, and new UI components integrated into the existing `tdocs-*` shell.

## Problem Frame

The current home page lists all workbooks as a flat time-sorted table ("最近"). For a workspace with many workbooks, organisation into folders is essential. The Tencent Docs mental model (familiar to target users) uses a hierarchical folder tree in the left sidebar with a content pane on the right — we replicate that exactly.

## Requirements Trace

- R1. Left rail under "我的文档" shows an expandable folder tree for the workspace.
- R2. Right main area shows the contents of the currently selected folder: subfolders first, then workbooks, in a dense table with Name / Owner / Last Modified / Size columns.
- R3. A folder can contain zero or more subfolders and zero or more workbooks.
- R4. A workbook can be in at most one folder at a time (exclusive membership).
- R5. Workbooks not assigned to any folder appear in an "未分类" section at the bottom of the right pane (visible when workspace root is selected) and in the flat Recent list.
- R6. Folder operations: create, rename, delete (blocked if non-empty), move (drag-to-parent or context menu).
- R7. Workbook operations from the tree: open, attach to folder, detach from folder, context menu with standard actions (open in new window, rename, move to, delete).
- R8. Move folder must be atomic — no orphaned nodes on connection interruption.
- R9. PERMISSIONS follow existing `owns_workspace` / `member_identifies_user` pattern; owner can write, members can read.
- R10. Maximum nesting depth: 8 levels (cycle detection required on move).

## Scope Boundaries

- No real-time LIVE SELECT on folder tables in this phase — load on mount, invalidate after local mutations (same as `useWorkspace`).
- No folder sharing between workspaces.
- No drag-and-drop in this phase — move via context menu "移动到…" only.
- No folder-level permissions beyond workspace owner/member.
- No duplicate-name validation (siblings may share the same name).
- File upload to folders is out of scope.

## Context & Research

### Relevant Code and Patterns

- `schema/main.surql` — all existing table and edge definitions; new tables must match this pattern exactly (`DEFINE TABLE IF NOT EXISTS ... SCHEMAFULL PERMISSIONS ...`).
- `src/lib/surreal/ddl.ts` — `RESERVED_TABLE_NAMES` set; new table names must be added here.
- `src/features/workbook/use-workspace.ts` — canonical `useReducer` + `useEffect` data-loading hook pattern with `cancelled` guard.
- `src/features/workbook/use-sheets.ts` — second example of the same hook pattern with optimistic append.
- `src/features/workbook/app-shell.tsx` — home shell; the `tdocs-*` tab bar and left rail are the integration points.
- `src/styles/global.css` — `tdocs-*` CSS classes; new `tdocs-tree-*` classes go here.
- `src/admin/admin-sidebar.test.tsx` — closest test analog (panel that loads from DB on mount, uses `createMockDb` factory).
- `src/app/router.tsx` — routing; "我的文档" is a tab state inside `/workbooks`, not a new route.

### Institutional Learnings

- The project's one documented schema solution (`docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md`) confirms: ordered sequences use a `position: int` field per record, not an array-on-parent. This plan uses `position` on the edge record `folder_parent`.
- CLAUDE.md hard rule: permissions belong in the schema `DEFINE TABLE ... PERMISSIONS` blocks, never in query `WHERE` clauses.
- CLAUDE.md hard rule: invoke the `surrealdb` skill before writing any SurrealQL. The implementing agent must do this.

### External References

- SurrealDB edge table `TYPE RELATION ENFORCED` is the idiomatic pattern for a self-referential tree; do not use a `parent: option<record<folder>>` field (no `->` traversal support on plain record links).
- SurrealDB has no recursive SELECT keyword; use bounded multi-hop traversal (`->folder_parent->folder->folder_parent->folder...`) up to max depth 8, or a `DEFINE FUNCTION fn::folder_children` stored function.
- Edge PERMISSIONS can reference `in` / `out` directly; each table's PERMISSIONS are self-contained — always walk back to the ownership graph.
- Move atomicity: wrap DELETE old-parent-edge + RELATE new-parent-edge in a single `BEGIN TRANSACTION; ...; COMMIT;` block executed as one `db.query()` call.

## Key Technical Decisions

- **Edge table for parent-child**: `folder_parent TYPE RELATION IN folder OUT folder` with `DEFINE INDEX ... COLUMNS in UNIQUE` (one parent per folder, tree invariant). Traversal direction: child `->folder_parent->` parent. This matches the codebase's existing graph idiom and enables native `->` traversal in PERMISSIONS.
- **Edge table for workbook attachment**: `folder_has_workbook TYPE RELATION IN folder OUT workbook` with `DEFINE INDEX ... COLUMNS out UNIQUE` (one folder per workbook, exclusive membership as per user's choice). PERMISSIONS anchored to the folder's workspace.
- **Workspace root edge**: `workspace_has_folder TYPE RELATION IN workspace OUT folder` (mirrors `workspace_has_workbook`). Top-level folders point here; this is the permission anchor for all `folder` SELECT checks.
- **Tab placement**: "我的文档" is a second tab inside the existing `tdocs-tabs` bar on `/workbooks`. No new route. The existing `AppShell` receives a new `activeTab` state (`'recent' | 'my-docs'`) managed in the route component.
- **Tree data strategy**: load the full flat list of `folder` records for the workspace in one query, build the tree in memory (sort by `parent`, `position`). Re-fetch after any mutation. This mirrors `useWorkspace`'s one-shot load approach. No LIVE SELECT.
- **Right pane query**: on folder selection, fetch immediate children (folders by `<-folder_parent<-folder WHERE out = $folderId`) and attached workbooks (by `<-folder_has_workbook<-folder WHERE in = $folderId`) in one batched `db.query()` call.
- **Unfiled workbooks**: workbooks not present in any `folder_has_workbook` edge. Query: `SELECT * FROM workbook WHERE workspace = $wsId AND id NOT IN (SELECT VALUE out FROM folder_has_workbook WHERE out.workspace = $wsId)`.
- **Context menu**: a stateful `contextMenu: { folderId, x, y } | null` in component state, rendered as an absolutely-positioned overlay; no third-party menu library.

## Open Questions

### Resolved During Planning

- **Single vs. multi-folder membership**: exclusive (UNIQUE index on `folder_has_workbook.out`). User confirmed.
- **Delete non-empty folder**: blocked with error message listing contents count. User confirmed.
- **Move atomicity**: SurrealDB transaction wrapping both edge writes. Confirmed via external research.
- **Entry point**: tab inside existing shell, left rail shows folder tree, right pane shows folder contents. User confirmed (matches Tencent Docs "My Cloud Doc" layout).
- **Max nesting depth**: 8 levels enforced on the client before creating/moving.
- **Sibling ordering**: `position: int` on the `folder_parent` edge record (consistent with `sheet.position` precedent).

### Deferred to Implementation

- Exact SurrealQL for the `fn::folder_descendants` stored function (depth-bounded BFS) — decide during Unit 1 whether a client-side walk suffices for max-8-depth trees.
- Whether to surface a "Move to…" modal with a tree picker or a flat folder list dropdown — defer to Unit 4 implementation.
- Whether expand/collapse state persists to sessionStorage — implement if time allows in Unit 5.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data Model (ERD sketch)

```
workspace
  │ workspace_has_folder (RELATION)
  ▼
folder ──┐
  │      │ folder_parent (RELATION, in=child, out=parent)
  │      │   └─ UNIQUE INDEX on `in` (one parent per folder)
  │      │   └─ position: int (sibling order)
  └──────┘
  │ folder_has_workbook (RELATION)
  │   └─ UNIQUE INDEX on `out` (one folder per workbook)
  ▼
workbook (existing table, no schema change needed)
```

Permission chain for `folder.SELECT`:
```
id IN $auth->owns_workspace->workspace->workspace_has_folder->folder
OR id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace->workspace_has_folder->folder
```

Permission chain for `folder.CREATE` (graph edge not yet created):
```
workspace IN $auth->owns_workspace->workspace
```

### UI Layout

```
┌─ tdocs-topbar ─────────────────────────────────────────────────────┐
│  债权文档  [search…]                          [连接状态] [avatar]   │
├─ tdocs-body ────────────────────────────────────────────────────────┤
│ tdocs-rail (200px)          │ tdocs-main                            │
│                             │                                       │
│  + 新建                     │  最近 │ 我的文档 │ 空间 │ 收藏        │
│                             │ ─────────────────────────────────     │
│  🏠 首页                    │  My Cloud Doc          ≡ Filter ▾     │
│  ▼ 📁 我的文档  ← selected  │  ─────────────────────────────────    │
│      ▶ 📁 案件台账          │  Name        Owner  Modified   Size   │
│      ▶ 📁 债权申报          │  📁 案件台账   Me    04/08      —      │
│  ✕ AI文档助手               │  📁 债权申报   Me    04/07      —      │
│  □ 空间                     │  📗 Q4总表     Me    04/06   15KB      │
│                             │  ─ 未分类 (2) ──────────────────────  │
│                             │  📗 空白工作簿 Me    03/04   94KB      │
└─────────────────────────────┴──────────────────────────────────────┘
```

Context menu (right-click on folder or workbook row):
```
┌─────────────────────────┐
│ 在新窗口中打开           │
│ ─────────────────────── │
│ 新建子文件夹             │
│ 重命名                   │
│ 移动到…                  │
│ ─────────────────────── │
│ 删除                     │
└─────────────────────────┘
```

## Implementation Units

- [ ] **Unit 1: SurrealDB schema — folder tables and edges**

**Goal:** Define `folder`, `folder_parent`, `folder_has_workbook`, and `workspace_has_folder` tables in the schema with correct PERMISSIONS, indexes, and field types. Register names in `RESERVED_TABLE_NAMES`.

**Requirements:** R3, R4, R9

**Dependencies:** None

**Files:**
- Modify: `schema/main.surql`
- Modify: `src/lib/surreal/ddl.ts`

**Approach:**
- Add four new table definitions after the `workbook` section in `main.surql`, following the exact `DEFINE TABLE IF NOT EXISTS ... SCHEMAFULL PERMISSIONS ...` style.
- `folder`: fields `workspace: record<workspace>`, `name: string`, `created_at`, `updated_at`. PERMISSIONS follow the `workspace_has_folder` graph chain (SELECT) and workspace-field check (CREATE). Owner-only write.
- `workspace_has_folder`: `TYPE RELATION IN workspace OUT folder SCHEMAFULL ENFORCED`. SELECT/create/delete WHERE `in = $auth->owns_workspace->workspace` (owner path) plus member read path.
- `folder_parent`: `TYPE RELATION IN folder OUT folder SCHEMAFULL ENFORCED`. Fields: `position: int DEFAULT 0`, `created_at`. UNIQUE INDEX on `in` (tree invariant). PERMISSIONS: same ownership graph chain as `folder`.
- `folder_has_workbook`: `TYPE RELATION IN folder OUT workbook SCHEMAFULL ENFORCED`. UNIQUE INDEX on `out` (exclusive membership). PERMISSIONS: SELECT via `in IN ...->workspace_has_folder->folder`; create/delete owner-only.
- Add all four names to `RESERVED_TABLE_NAMES` in `ddl.ts`.

**Execution note:** Invoke the `surrealdb` skill before writing any SurrealQL. Write the DDL, then verify permissions logic against the `CLAUDE.md` checklist (no auth-filtering in queries, graph traversal in PERMISSIONS, CREATE uses workspace field not graph edge).

**Patterns to follow:**
- `schema/main.surql` lines 70–90 (`workbook` table) for record table pattern.
- `schema/main.surql` `workspace_has_workbook` edge for relation table pattern.
- `src/lib/surreal/ddl.ts` `RESERVED_TABLE_NAMES` set.

**Test scenarios:**
- Test expectation: none — this is pure DDL with no React component. Schema correctness is verified in Unit 2 when queries are first exercised against a real or mocked DB.

**Verification:**
- All four table names appear in `RESERVED_TABLE_NAMES`.
- DDL is idempotent (`IF NOT EXISTS` on every DEFINE).
- PERMISSIONS clauses never contain raw auth-filtering `WHERE` predicates in queries — only schema-level blocks.

---

- [ ] **Unit 2: `useDocTree` hook — load folder tree and unfiled workbooks**

**Goal:** A React hook that fetches the full flat list of `folder` records for the workspace, builds an in-memory tree, and separately fetches workbooks not in any folder ("unfiled").

**Requirements:** R1, R2, R5

**Dependencies:** Unit 1

**Files:**
- Create: `src/features/my-docs/use-doc-tree.ts`
- Create: `src/features/my-docs/use-doc-tree.test.ts`

**Approach:**
- State shape: `{ folders: FolderNode[], unfiledWorkbooks: Workbook[], isLoading: boolean, error: string | null }` managed with `useReducer` using `load-start | load-ok | load-err` actions (mirrors `use-workspace.ts`).
- On mount: run a batched `db.query<[FolderRow[], WorkbookRow[]]>(SURQL, { wsId })` call:
  - Query 1: `SELECT id, name, workspace, created_at, updated_at FROM folder WHERE workspace = $wsId`.
  - Query 2: `SELECT id, name, updated_at FROM workbook WHERE workspace = $wsId AND id NOT IN (SELECT VALUE out FROM folder_has_workbook WHERE out.workspace = $wsId)`.
  - NOTE: permissions enforced by DB engine; no auth conditions in the query itself.
- After load, fetch all `folder_parent` edges to get parent/child relationships and `position` values. Build the in-memory tree (Map keyed by folder ID, children sorted by position).
- Cancellation guard: `let cancelled = false` + `if (cancelled) return` inside the async effect.
- Export a `refetch` callback for post-mutation invalidation.
- Type `FolderNode`: `{ id: string; name: string; children: FolderNode[]; workbooks: WorkbookRef[]; depth: number }`. The hook returns root-level folders only; each `FolderNode` contains its children recursively up to max depth 8.

**Patterns to follow:**
- `src/features/workbook/use-workspace.ts` — `useReducer`, `useEffect`, cancellation guard, `db` passed as prop.
- `src/features/workbook/use-sheets.ts` — `useCallback` for mutation callbacks.

**Test scenarios:**
- Happy path: `db.query` resolves with 3 folders (2 root-level, 1 child) and 1 unfiled workbook → `folders` has 2 root nodes, child is nested under correct parent, `unfiledWorkbooks` has 1 entry.
- Empty workspace: both queries return empty arrays → `folders = []`, `unfiledWorkbooks = []`, no error.
- DB error: `db.query` rejects → `error` is set, `isLoading` is false.
- Cancellation: component unmounts before query resolves → state is never updated (no state-after-unmount warning).
- Depth enforcement: flat list contains a chain longer than 8 levels → tree is truncated at depth 8, excess nodes are dropped (or attached to root as orphans — document the choice).
- Orphaned folder (parent id doesn't match any folder in result): attaches to root as a safety fallback.

**Verification:**
- All test scenarios pass.
- Hook exports: `{ folders, unfiledWorkbooks, isLoading, error, refetch }`.

---

- [ ] **Unit 3: `useFolderContents` hook — load one folder's immediate children**

**Goal:** A hook that, given a selected folder ID, fetches its immediate child folders and attached workbooks in a single batched query. Used to populate the right-side content pane.

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Create: `src/features/my-docs/use-folder-contents.ts`
- Create: `src/features/my-docs/use-folder-contents.test.ts`

**Approach:**
- Props: `db: Surreal`, `folderId: string | null` (null = workspace root, shows all top-level folders + unfiled workbooks).
- State: `{ subfolders: FolderRow[], workbooks: WorkbookRow[], isLoading, error }`.
- Batched query:
  - Subfolders: `SELECT in.* FROM folder_parent WHERE out = $folderId ORDER BY position ASC` (children of this folder).
  - Workbooks: `SELECT out.* FROM folder_has_workbook WHERE in = $folderId ORDER BY out.updated_at DESC`.
- Re-runs when `folderId` changes. Uses `useEffect` + cancellation guard.
- Export `refetch` callback.

**Patterns to follow:** Same as Unit 2.

**Test scenarios:**
- Happy path: folder has 2 subfolders and 1 workbook → both are returned in correct arrays.
- Empty folder: both queries return empty → `subfolders = []`, `workbooks = []`, no error.
- `folderId = null`: hook should be dormant / return empty until a real folder is selected (or handle root-level fetch differently).
- DB error: `error` is set.

**Verification:** All test scenarios pass.

---

- [ ] **Unit 4: Folder mutation functions — create, rename, delete, move**

**Goal:** Pure async functions (not hooks) that issue SurrealDB writes for each folder operation. Each function returns `{ ok: true } | { ok: false; error: string }`.

**Requirements:** R6, R8, R10

**Dependencies:** Unit 1

**Files:**
- Create: `src/features/my-docs/folder-mutations.ts`
- Create: `src/features/my-docs/folder-mutations.test.ts`

**Approach:**

- **`createFolder(db, { name, workspaceId, parentFolderId?, position })`**:
  - `CREATE folder SET workspace = $ws, name = $name, ...`.
  - If `parentFolderId`: `RELATE $child->folder_parent->$parent SET position = $pos`.
  - Else: `RELATE $ws->workspace_has_folder->$child`.
  - Two queries chained (not transactional — creation is not a risk case since if the second query fails the folder simply appears at root level on re-fetch).

- **`renameFolder(db, { folderId, name })`**:
  - `UPDATE folder:$id SET name = $name, updated_at = time::now()`.

- **`deleteFolder(db, { folderId })`**:
  - First check: count immediate children (`SELECT count() FROM folder_parent WHERE out = $id`) and attached workbooks (`SELECT count() FROM folder_has_workbook WHERE in = $id`). If either > 0, return `{ ok: false, error: '文件夹不为空，请先移除其中的内容' }`.
  - If empty: `DELETE folder:$id` (DB cascades edge deletion automatically for edges touching a deleted node in SurrealDB 2+).

- **`moveFolder(db, { folderId, newParentId, position })`** (atomic):
  - Client-side cycle check first: walk ancestor chain of `newParentId` (up to 8 hops via `SELECT VALUE out FROM folder_parent WHERE in = $id`) and verify `folderId` is not in the ancestor set. If cycle detected, return error immediately without writing.
  - Depth check: compute current depth of `newParentId` + 1 ≤ 8. Return error if exceeded.
  - Atomic write:
    ```
    BEGIN TRANSACTION;
    DELETE folder_parent WHERE in = $folderId;
    RELATE $folderId->folder_parent->$newParentId SET position = $position;
    COMMIT;
    ```
  - Executed as a single `db.query()` string.

- **`attachWorkbook(db, { folderId, workbookId })`**:
  - First detach if already in a folder: `DELETE folder_has_workbook WHERE out = $workbookId`.
  - Then: `RELATE $folderId->folder_has_workbook->$workbookId`.

- **`detachWorkbook(db, { workbookId })`**:
  - `DELETE folder_has_workbook WHERE out = $workbookId`.

**Patterns to follow:**
- `src/shell/template-provisioning.ts` — multi-step SurrealQL with `db.query()`.
- Result type `{ ok: true } | { ok: false; error: string }` (same as `provisionTemplate`).

**Test scenarios:**
- createFolder happy path: `db.query` called twice (CREATE then RELATE) → returns `{ ok: true }`.
- createFolder DB error: first query rejects → returns `{ ok: false, error: ... }`.
- deleteFolder non-empty: mock DB returns count > 0 → returns `{ ok: false, error: '...' }` without calling DELETE.
- deleteFolder empty: mock returns count 0 → DELETE called, returns `{ ok: true }`.
- moveFolder cycle detection: newParentId ancestor chain includes folderId → returns error, db.query not called.
- moveFolder depth exceeded: depth of newParentId is 8 → returns error.
- moveFolder happy path: BEGIN/COMMIT transaction string sent as single `db.query()` call.
- attachWorkbook: detach query called first, then RELATE.
- detachWorkbook: DELETE edge query sent.

**Verification:** All mutation functions return typed results; move uses a single transactional query; cycle detection prevents DB writes.

---

- [ ] **Unit 5: `DocTreePanel` — left rail tree component**

**Goal:** A React component that renders the expandable folder tree in the left rail under the "我的文档" nav item. Clicking a folder selects it (updates parent state). Right-click opens the context menu. Inline rename input on rename action.

**Requirements:** R1, R6, R7

**Dependencies:** Units 2, 4

**Files:**
- Create: `src/features/my-docs/doc-tree-panel.tsx`
- Create: `src/features/my-docs/doc-tree-panel.test.tsx`
- Modify: `src/styles/global.css` (add `tdocs-tree-*` classes)

**Approach:**
- Props: `{ db, workspaceId, selectedFolderId: string | null, onSelectFolder: (id: string | null) => void }`.
- Uses `useDocTree(db, workspaceId)` internally.
- Renders a recursive `FolderTreeItem` sub-component for each `FolderNode`. Indent per level: `padding-left: calc(16px * depth)`.
- Each item has: expand/collapse chevron (`▶` / `▼`), folder icon, label (or inline `<input>` during rename), and a `...` overflow button that triggers context menu.
- Context menu state: `{ type: 'folder' | 'workbook', id: string, x: number, y: number } | null`. Rendered as an absolutely-positioned `<menu>` element, closed on outside click (`useEffect` with `document.addEventListener('click', ...)`).
- Context menu items for folder: 新建子文件夹 / 重命名 / 移动到… / 删除.
- On create/rename/delete/move success: call `refetch()` from `useDocTree`.
- Inline rename: on "重命名" click, set `editingId = folderId`, render `<input>` pre-filled with current name, `onBlur` / Enter key commits, Escape cancels.
- CSS: extend `global.css` with `tdocs-tree-item`, `tdocs-tree-item--selected`, `tdocs-tree-item__chevron`, `tdocs-tree-item__icon`, `tdocs-tree-item__label`, `tdocs-tree-item__actions`, `tdocs-context-menu`, `tdocs-context-menu__item`.

**Patterns to follow:**
- `src/admin/admin-sidebar.tsx` — panel with sections, context-sensitive rendering.
- `tdocs-rail-item` / `tdocs-rail-item--active` CSS pattern for selected state.

**Test scenarios:**
- Happy path render: tree loads 2 root folders → both rendered; folder names visible.
- Expand/collapse: clicking chevron on a folder with children toggles visibility of children.
- Select folder: clicking folder name calls `onSelectFolder` with correct ID.
- Rename flow: "重命名" menu item clicked → input appears with current name; Enter commits and calls `renameFolder`; Escape reverts without calling rename.
- Delete empty folder: "删除" clicked → `deleteFolder` called; on success tree refetches.
- Delete non-empty: `deleteFolder` returns error → error toast shown, tree not refetched.
- Context menu closes on outside click.
- Loading state: while `useDocTree.isLoading`, render a skeleton/loading indicator.
- Error state: `useDocTree.error` set → render error message.

**Verification:** Component renders tree without console errors; all interactions update state correctly; CSS classes match `tdocs-tree-*` namespace.

---

- [ ] **Unit 6: `FolderContentsPane` — right-side content table**

**Goal:** A React component that renders the contents of the selected folder as a dense table (subfolders first, then workbooks), with a context menu per row and a column header matching the Tencent Docs layout (Name / Owner / Last Modified / Size).

**Requirements:** R2, R5, R7

**Dependencies:** Units 3, 4, 5

**Files:**
- Create: `src/features/my-docs/folder-contents-pane.tsx`
- Create: `src/features/my-docs/folder-contents-pane.test.tsx`

**Approach:**
- Props: `{ db, workspaceId, selectedFolderId: string | null, displayName?: string, onOpenWorkbook: (id: string) => void, onFolderSelect: (id: string) => void }`.
- Uses `useFolderContents(db, selectedFolderId)`.
- When `selectedFolderId` is null (workspace root selected), shows top-level folders + unfiled workbooks section.
- Table structure: reuse `tdocs-table` CSS class; row types: folder row (double-click navigates into folder in the tree) and workbook row (click opens workbook).
- Folder icon: teal square folder SVG (matching the screenshot). Workbook icon: green spreadsheet SVG (matching `tdocs-file-icon--sheet`).
- Context menu per row (same overlay pattern as `DocTreePanel`).
- "未分类" section: rendered as a separator row with count, followed by unfiled workbook rows. Only shown at root level.
- Header row: shows current folder name as breadcrumb title above the table. Clicking a breadcrumb segment navigates up.
- Empty state: folder is empty → "该文件夹为空" with a "新建子文件夹" button.

**Patterns to follow:**
- `tdocs-table` / `tdocs-table__row` / `tdocs-table__name-cell` existing CSS pattern.
- `app-shell.tsx` HomeStateSurface pattern for loading/error/empty states.

**Test scenarios:**
- Happy path: folder has 1 subfolder and 2 workbooks → table renders subfolder first, then workbooks.
- Workbook row click: calls `onOpenWorkbook` with correct ID.
- Folder row double-click: calls `onFolderSelect` with correct ID.
- Unfiled section: visible at root level with correct count of unfiled workbooks.
- Empty folder: empty state renders with "新建子文件夹" button.
- Loading state: renders loading indicator.
- Error state: renders error message.

**Verification:** Table columns match Tencent Docs layout; folder navigation works; workbook open callback fires correctly.

---

- [ ] **Unit 7: Wire into AppShell — "我的文档" tab integration**

**Goal:** Connect `DocTreePanel` and `FolderContentsPane` into the existing home shell. Add "我的文档" as a second tab in the `tdocs-tabs` bar. Left rail shows the folder tree under the "我的文档" nav item. Right pane switches between the flat Recent table and the folder contents table based on active tab.

**Requirements:** R1, R2

**Dependencies:** Units 5, 6

**Files:**
- Modify: `src/features/workbook/app-shell.tsx`
- Modify: `src/styles/global.css` (minor layout adjustment if needed)
- Modify: `src/app/router.tsx` (no new route, but may need to pass new props)
- Modify: `src/features/workbook/app-shell.test.tsx`

**Approach:**
- Add `activeHomeTab: 'recent' | 'my-docs'` and `selectedFolderId: string | null` to home view state in `AppShell` (or hoist to the route component in `router.tsx` if preferred).
- Tab bar: add `我的文档` tab between `最近` and `空间`. Clicking it sets `activeHomeTab = 'my-docs'`.
- Left rail: when `activeHomeTab === 'my-docs'`, the "我的文档" rail item is shown as active and `DocTreePanel` is rendered below it (inline in the rail, expanding the rail height). Otherwise the rail shows the standard nav items.
- Main pane: when `activeHomeTab === 'recent'` render the existing flat table; when `activeHomeTab === 'my-docs'` render `FolderContentsPane` with `selectedFolderId`.
- `onOpenWorkbook` in `FolderContentsPane` → calls existing `onSelectWorkbook`.
- No changes to `AppShellProps` public interface beyond adding `ownerUserId` which already exists.

**Patterns to follow:**
- Existing `tdocs-tab--active` toggle in the tab bar.
- Existing `rail-button--active` for selected rail item.

**Test scenarios:**
- Tab click: clicking "我的文档" tab renders `FolderContentsPane` in main area; clicking "最近" restores the flat table.
- Rail tree visible: when "我的文档" tab is active, left rail shows folder tree items.
- Opening workbook from tree: `onSelectWorkbook` called with correct ID.

**Verification:** Both tabs render without errors; switching tabs does not lose scroll position of Recent list; no TypeScript errors introduced.

---

## System-Wide Impact

- **Interaction graph:** `useWorkspace` and `useDocTree` both query `workbook` records for the same workspace. They are independent hooks with separate state — no shared cache. After a workbook is created (via `handleCreateWorkbook` in `AppShell`), the "Recent" list re-fetches via `useWorkspace`; the "My Documents" tree does not auto-update (user must switch tabs or refresh). This is acceptable for the initial phase.
- **Error propagation:** mutation errors (rename, delete, move) surface as inline error messages in the UI or toasts via the existing `shell/toast` pattern. They do not propagate to parent state.
- **State lifecycle risks:** move atomicity is protected by the transaction wrapper in `moveFolder`. The only residual risk is a folder created but not yet `RELATE`d to a parent (Unit 4 `createFolder` is two queries). In practice this means the folder appears at "root" if the second query fails — a benign degradation.
- **API surface parity:** the `workbook` table schema is unchanged. The `workspace_has_workbook` edge remains the canonical workbook-visibility permission anchor. Folder attachment is additive.
- **Integration coverage:** the full flow "create folder → attach workbook → open workbook from tree" spans Units 1–7 and should be validated with a browser-level QA pass (use `/qa` skill) after Unit 7 lands.
- **Unchanged invariants:** existing `/workbooks` Recent tab, `/workbooks/$workbookId` editor, public form routes, and admin sidebar are unaffected. The `AppShellProps` contract gains only internal tab state — no breaking changes to callers in `router.tsx`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SurrealDB `BEGIN TRANSACTION` not available in SDK 2.0.3 | Verify in Unit 4 implementation; fall back to sequential queries with client-side orphan detection if transactions are unsupported |
| Cycle detection query times out on 8-level deep tree | Walk is bounded to 8 hops client-side before any write; maximum 8 `db.query` round-trips in worst case |
| UNIQUE index on `folder_parent.in` rejected by SurrealDB for self-referential edge | Verify DDL in Unit 1; if unsupported, enforce the single-parent invariant at the application layer in `createFolder` / `moveFolder` |
| `DELETE folder` does not auto-cascade edges in SDK version | Explicitly DELETE `folder_parent` and `workspace_has_folder` edges before deleting the folder record in `deleteFolder` |
| Left rail height grows unbounded with deep trees | Cap visible tree depth at 8 in `DocTreePanel`; add `overflow-y: auto` to rail |

## Sources & References

- Related code: `schema/main.surql`, `src/features/workbook/use-workspace.ts`, `src/features/workbook/app-shell.tsx`, `src/lib/surreal/ddl.ts`
- Design reference: `DESIGN.md` — `tdocs-*` shell aesthetic, spacing tokens, 8px base unit
- SurrealDB edge TYPE RELATION ENFORCED documentation (SurrealDB 2.x / 3.x)
- Screenshot reference: Tencent Docs "My Cloud Doc" page (provided by user, 2026-04-11)
