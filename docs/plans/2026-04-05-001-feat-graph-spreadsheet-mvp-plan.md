---
title: "feat: Graph-Powered Collaborative Spreadsheet MVP"
type: feat
status: active
date: 2026-04-05
deepened: 2026-04-05
origin: /Users/y/.gstack/projects/MainListActivity-surreal_ck/ceo-plans/2026-04-05-graph-spreadsheet-mvp.md
---

# feat: Graph-Powered Collaborative Spreadsheet MVP

## Overview

Build the full MVP of surreal_ck: a graph-powered collaborative spreadsheet for legal-finance work. The product is a static TypeScript/Vite frontend that embeds Univer (open-source spreadsheet engine) and connects directly to SurrealDB 3.0 over WebSockets — no backend server. The stack is: one Docker container (SurrealDB), one static site (Vite build).

The MVP delivers: real-time multi-user collaboration via a mutations table + LIVE SELECT, a `GRAPH_TRAVERSE` custom async formula, public intake forms with file uploads, an admin sidebar for schema/form management, CSV import with validation, template picker for first-run, and a daily backup script.

## Problem Frame

Legal-finance professionals (lawyers, legal ops) handle ownership chains, entity relationships, and client intake using a patchwork of spreadsheets + email. SurrealDB's graph model can make those relationships live and traversable inside a spreadsheet. The wedge is legal finance; the core tech is domain-agnostic. The MVP validates: (1) can graph traversal inside a spreadsheet feel native, and (2) does real-time form intake into a live grid create a meaningful workflow advantage?

## Requirements Trace

- R1. User can log in and land in a workbook (returning) or template picker (new user)
- R2. Workbook canvas is a full Univer spreadsheet connected to SurrealDB entity tables
- R3. Multiple users editing the same workbook see each other's changes in ≤2s (real-time collab via mutations table + LIVE SELECT)
- R4. `GRAPH_TRAVERSE(startNode, relationship, depth)` formula returns graph-traversal results asynchronously, displayed in cell + expandable sidebar panel
- R5. Public intake form (static page, mobile-friendly) submits into SurrealDB transactionally; row appears in lawyer's grid via LIVE SELECT
- R6. File uploads attach to intake form submissions via SurrealDB DEFINE BUCKET
- R7. Admin sidebar (admin-only) manages entity types, relationship types, form definitions, workspace members
- R8. CSV import: upload → column mapping → dry-run preview with validation → commit (500-row chunks)
- R9. SurrealDB schema defined in `schema/main.surql`; idempotent; applied on deploy
- R10. Daily backup via `surreal export` cron with 30-day retention and failure logging
- R11. First-run experience: template picker with Legal Entity Tracker, Case Management, and Blank Workspace options
- R12. Design system from `DESIGN.md` applied consistently across all UI surfaces
- R13. Week 0 spike validates Univer mutation replay (`executeCommand` with `fromCollab: true`) before full collab build

## Scope Boundaries

- No Univer Pro license. Open-source Univer only.
- No backend HTTP server. Frontend connects directly to SurrealDB via WebSocket.
- No Redis, RabbitMQ, PostgreSQL, MinIO, or Bun server.
- `GRAPH_AGGREGATE` formula deferred to post-MVP.
- Audit trail UI (cell history panel) deferred to post-MVP (TODOS.md P3).
- Server-side CAPTCHA verification deferred to pre-launch (TODOS.md P2).
- Off-site backup deferred to pre-launch (TODOS.md P2).
- Form rate limiting deferred to pre-launch (TODOS.md P2).
- Phone spreadsheet editing not supported; phone defaults to read-only record-list mode.
- No dark mode at MVP (design system defines it, but implementation is deferred).

## Context & Research

### Relevant Code and Patterns

- `DESIGN.md` — complete authoritative design system; must be read before any visual decision
- `TODOS.md` — engineering backlog with explicit dependency ordering (Week 1 / Week 2 structure implied)
- CEO plan at `ceo-plans/2026-04-05-graph-spreadsheet-mvp.md` — full architecture, schema, collab design, error states, and scope decisions

### Institutional Learnings

- No prior `docs/solutions/` entries — greenfield project. Document learnings via `ce-compound` as each major system is completed.

### External References

- Univer packages: `@univerjs/presets` + `@univerjs/preset-sheets-core` for bootstrap; `@univerjs/engine-formula` for async formula registration via `univerAPI.getFormula().registerAsyncFunction()`
- SurrealDB SDK: `surrealdb` npm package v2.0.3; use `db.live(new Table(...))` for managed live queries (auto-reconnects); raw `db.query()` live selects do NOT auto-reconnect
- Univer mutation capture: use `univerAPI.addEvent(univerAPI.Event.CommandExecuted, cb)` — the old `univerAPI.onCommandExecuted()` is deprecated
- Univer mutation replay: `commandService.executeCommand(id, params, { fromCollab: true })` — filter `options?.fromCollab === true` in capture listener to prevent broadcast loop
- SurrealDB file storage: no SDK helpers; all bucket operations via `db.query()` with `f"bucket:/path"` syntax
- `@surrealdb/wasm` + `createRemoteEngines()` required if running SDK in a Web Worker
- All `@univerjs/*` packages must share identical semver — version mismatch causes silent DI failures

### Stitch Design Screens (project 3112663124167495317)

Key screens available for implementation reference:
- "Workbook View (Main Grid) - surreal_ck style" — primary app shell layout
- "Admin Sidebar Configuration - surreal_ck style" — admin sidebar panel
- "Template Picker (surreal_ck style)" — first-run template selection
- "Blank Workspace Guided Setup" — guided setup panel for blank workspace
- "Public Intake Form - surreal_ck style" — public intake form
- "Public Intake Submission Confirmation" — form success state (dedicated page, not toast)
- "CSV Import Workspace" + "Import Field Mapping" + "Import Validation Results" + "Import Commit Confirmation" + "Import Error Repair" — full CSV import flow
- "Action Sheet Review Queue" (desktop + mobile) — action sheet pattern
- "File Preview Overlay" — file attachment preview
- "Ownership Report Preview" + mobile variant — graph traversal result display
- "Graph Lineage Entity Detail" — entity detail sidebar panel
- "Activity Timeline Audit Log" variants — recent changes sidebar
- "Document Drawer" — document reading panel
- "Entity Specific History Panel" — per-entity history (post-MVP but design exists)

## Key Technical Decisions

- **Direct SurrealDB WebSocket connection (no backend)**: Client authenticates directly to SurrealDB via `db.signin()`. JWT stored in memory; refresh handled by SDK. Eliminates server maintenance cost; accepted trade-off is that business logic lives in SurrealQL permissions + client JS.
- **Mutations table as collab bus**: Not OT/CRDT — cell-level last-write-wins via server-assigned `ts` (eliminates clock skew). Simpler to implement, acceptable for legal workloads where concurrent same-cell edits are rare.
- **Snapshot coordinator via lowest-client-id election**: The client with the lexicographically lowest `client_id` among active connections is coordinator. Presence detected via a `presence` table with LIVE SELECT. Coordinator writes snapshot every 100 mutations or 10 minutes. On coordinator disconnect, next-lowest client takes over (detected within 30s).
- **GRAPH_TRAVERSE as async Univer formula**: Registered via `univerAPI.getFormula().registerAsyncFunction()`. Issues SurrealDB graph queries per depth level. Cell displays first 5 results + "(+N more)"; click opens sidebar. Error tokens: `#REF!`, `#NAME?`, `#VALUE!`, `#TIMEOUT!`.
- **Public form connects directly to SurrealDB via WSS**: No form server. `form_submit` DEFINE ACCESS scopes writes to the target table and its edge tables only. Cloudflare Turnstile client-side verification (server-side deferred to pre-launch).
- **SurrealDB DEFINE BUCKET for file storage**: Files stored via `f"spreadsheet_files:/path"` SurrealQL syntax. No SDK helper — all file ops via `db.query()`. Max 20MB enforced client-side; nginx `client_max_body_size 25m` as safety net. **Requires `--allow-experimental files` flag on SurrealDB server start** — must be in Docker command in `docker-compose.yml`. Bucket path must sanitize filenames (strip path separators, UUID-prefix) to prevent path traversal. Passing browser `File` as `ArrayBuffer` via `db.query()` parameters needs a proof-of-concept in Unit 0 or early Unit 8 before committing to this architecture.
- **Vite + TypeScript**: Static frontend. All `@univerjs/*` packages at identical semver. CSS import from `@univerjs/preset-sheets-core/lib/index.css` required.
- **schema.surql is the single source of truth**: All DEFINE TABLE/FIELD/ACCESS/INDEX/BUCKET statements in one file. Idempotent (`surreal import` is safe to re-run). Dynamic entity type tables created at runtime by admin via DDL.
- **Week 0 spike first**: Before building full collab, validate `executeCommand` replay in a two-tab test. The spike must explicitly test infinite-loop prevention (confirm `fromCollab: true` suppresses re-emission in open-source Univer, not just Univer Pro). Fallback plan: partial replay → snapshot broadcast; complete failure → snapshot-only sync; nuclear → single-user MVP.
- **Reconnect threshold**: >50 cached mutations OR >30s offline → snapshot sync fallback. Below threshold → replay cached mutations. Prevents unbounded replay on long-disconnect sessions.
- **LIVE SELECT reconnect ordering**: On reconnect, re-subscribe to LIVE SELECT first and buffer incoming events; complete mutation gap replay; then drain the buffer. This eliminates the TOCTOU window where mutations arrive between gap detection and re-subscription.
- **Snapshot coordinator correctness on failover**: When a new coordinator takes over, it must replay all mutations since the last written snapshot before writing a new one. Writing a snapshot immediately on election risks capping a stale state.
- **Form idempotency**: Submission token generated on form load, stored as unique field in SurrealDB. UI disables submit button immediately on first click. Prevents duplicate submissions in legal intake context.
- **CSV formula injection**: Silently strip leading `=`, `+`, `-`, `@`, `\t`, `\r` characters before inserting into Univer. Show post-import banner: "N cells contained formula characters and were escaped."
- **Template DDL scripts**: Templates stored as `.surql` files in `schema/templates/`. Each is idempotent and workspace-scoped. Running a template script creates entity types, relation types, form definitions, and sample records. **SurrealDB DDL transactionality is unverified** — `DEFINE TABLE`/`DEFINE FIELD` may not be rollback-able inside `BEGIN/COMMIT`. The provisioning strategy must account for this: run DDL first (idempotent), then DML in a transaction. On failure, compensating cleanup removes DML records; orphaned table definitions are handled by re-running the idempotent DDL on next attempt (safe because `DEFINE TABLE` is a no-op if the table already exists).

## Open Questions

### Resolved During Planning

- **Does SurrealDB 3 graph traversal deduplicate visited nodes?** Deferred to Week 0 spike verification. Plan assumes depth parameter bounds by hop count; explicit visited-set deduplication implemented client-side regardless to guarantee no duplicates.
- **Does `executeCommand(id, params, { fromCollab: true })` suppress re-broadcast?** Yes — confirmed via external research. The `fromCollab: true` option prevents re-emission from `onCommandExecuted`.
- **Does the SDK auto-reconnect on WebSocket drop?** Yes — `db.live(new Table(...))` managed live queries auto-resubscribe. Raw `db.query()` LIVE SELECT does not. Use managed queries throughout.
- **What form submission deduplication strategy?** Submission token (UUID generated on form load) stored as unique field in form record. Server rejects duplicate tokens with a user-friendly error.

### Deferred to Implementation

- **Exact coordinator election record schema**: Whether to use a `presence` table TTL record or a `coordinator` sentinel record; implementation discovers the cleaner approach during Unit 6. **Must define `client_id` generation strategy before implementing**: `client_id` must be session-unique (not user-scoped), so two browser tabs from the same user get different IDs. Recommend `crypto.randomUUID()` on session init, stored in `sessionStorage`.
- **Exact presence TTL value**: Determines the maximum zero-coordinator window (no snapshot writes). Must balance responsiveness vs. presence table churn. Suggested starting point: 60s TTL, refreshed every 20s.
- **Whether `syncOnly` mutations appear in collab capture**: Verify `onMutationExecutedForCollab` vs `onCommandExecuted` coverage during Week 0 spike. If formatting operations (bold, number format) use `syncOnly`, collaborative formatting will silently not work — verify in spike test matrix.
- **Whether `fromCollab: true` works in open-source Univer**: The option exists in Univer Pro's collab plugin; open-source command service behavior must be confirmed in spike. If it does not suppress re-emission, the entire mutation-replay architecture needs a client-side guard (filter by `client_id` of original sender instead).
- **SurrealDB bucket BACKEND value for production**: `"file:/data/uploads"` assumed; verify with actual Docker volume path during deployment setup.
- **Cloudflare Turnstile site key configuration**: Placeholder in form until production domain is registered.

## High-Level Technical Design

> *This illustrates the intended architecture and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Browser Tab (Lawyer)                    Browser Tab (External Client)
┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│ Vite SPA                        │    │ Static Form Page (public URL)   │
│                                 │    │                                 │
│ ┌─────────────────────────────┐ │    │ ┌─────────────────────────────┐ │
│ │ Univer Spreadsheet          │ │    │ │ React Form Component        │ │
│ │  + ColabPlugin              │ │    │ │  + Turnstile CAPTCHA        │ │
│ │  + GraphTraverseFormula     │ │    │ │  + File upload              │ │
│ │  + AdminSidebar             │ │    │ └──────────────┬──────────────┘ │
│ │  + TemplatePicker           │ │    └─────────────── │ ───────────────┘
│ └──────────────┬──────────────┘ │                     │
│                │                │                     │ WSS (form_submit access)
│ ┌──────────────▼──────────────┐ │                     │
│ │ SurrealDB JS SDK v2         │ │                     │
│ │  (main thread or WebWorker) │ │    ┌────────────────▼─────────────────┐
│ │  db.live(mutations table)   ◄─┼────►        SurrealDB 3.0.5           │
│ │  db.signin() JWT auth       │ │    │                                  │
│ └─────────────────────────────┘ │    │  mutations    snapshots           │
└─────────────────────────────────┘    │  workspace    workbook            │
                                       │  entity_*     form_definition     │
                                       │  presence     client_error        │
                                       │  spreadsheet_files (BUCKET)       │
                                       └──────────────────────────────────┘
```

**Collab data flow:**
```
User A edits cell
  → onCommandExecuted fires (type === MUTATION, options.fromCollab !== true)
  → mutation record INSERTed: {workbook_id, command_id, params, client_id, ts}
  → SurrealDB LIVE SELECT notifies User B
  → User B calls executeCommand(command_id, params, {fromCollab: true})
  → User B cell updates; fromCollab=true suppresses re-broadcast
```

**Reconnect flow:**
```
Disconnect detected
  → cache mutations in memory (cap 500)
  → on reconnect: gap detection query for oldest available mutation ts
  → if gap > 30s OR cached count > 50 → snapshot sync
  → else → replay cached mutations → re-subscribe LIVE SELECT
  → LIVE SELECT application paused during replay to prevent race
```

## Implementation Units

- [ ] **Unit 0: Week 0 Spike — Univer Mutation Replay Validation**

**Goal:** Prove that Univer mutations can be reliably captured via `addEvent(CommandExecuted)` and replayed via `executeCommand(id, params, {fromCollab: true})` before committing to the collab architecture.

**Requirements:** R3, R13

**Dependencies:** None

**Files:**
- Create: `spike/collab-test.html`
- Create: `spike/collab-test.ts`
- Create: `spike/README.md` (spike findings and decision)

**Approach:**
- Stand up two Univer instances in two browser tabs (or iframes on the same page)
- Connect both to a local SurrealDB instance
- Capture mutations from Tab A via `univerAPI.addEvent(univerAPI.Event.CommandExecuted, cb)` filtering `type === 2` and `!options?.fromCollab`
- Write mutation to a `spike_mutations` table in SurrealDB
- Tab B receives via `db.live(new Table('spike_mutations'))` and replays via `executeCommand`
- Test matrix: cell value (string/number), formatting, formula, row insert/delete, col insert/delete, cell merge, undo after remote mutation

**Test scenarios:**
- Happy path: edit string cell in Tab A → appears in Tab B within 1s
- Happy path: edit number cell → value and type preserved
- Happy path: apply bold formatting → formatting replayed
- Happy path: enter `=SUM(A1:A5)` → formula replayed, recalculates
- Happy path: insert row → row appears in Tab B at correct index
- Edge case: undo in Tab A after receiving Tab B mutation → only Tab A's local edit undone
- Edge case: paste 50 cells at once → captured as single or grouped mutation(s), Tab B receives all
- Error path: unknown `command_id` injected into mutations table → Tab B skips with log entry

**Verification:**
- Spike README documents: which command types replay cleanly, which fail, loop-prevention confirmed/denied (critical), chosen fallback strategy
- **Add to spike test matrix**: Tab A replays a mutation received from Tab B → confirm Tab A does NOT re-broadcast it (infinite loop prevention). This must pass before Unit 3 proceeds.
- **Add to spike test matrix**: Confirm `fromCollab: true` is respected by open-source `@univerjs/presets` command service (not only Univer Pro). If the flag is ignored, implement client-side sender-ID filtering as fallback guard.
- **Add to spike test matrix**: Identify which mutation types use `syncOnly` — if bold/formatting uses `syncOnly`, subscribe to `onMutationExecutedForCollab` in addition to `onCommandExecuted`.
- Decision gate: if >3 whitelisted commands fail replay → evaluate snapshot-only path; if loop prevention fails → design client-side guard before Unit 3

---

- [x] **Unit 1: Project Scaffold + Design System Foundation**

**Goal:** Initialize the Vite + TypeScript project with all dependencies, design system CSS variables, and base HTML shell. No app logic — just the foundation every subsequent unit builds on.

**Requirements:** R9, R12

**Dependencies:** Unit 0 findings inform whether `@univerjs/presets` (simpler) or full plugin mode is used

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/styles/design-system.css`
- Create: `src/styles/global.css`
- Create: `schema/main.surql`
- Create: `docker-compose.yml`
- Create: `.env.example`

**Approach:**
- Vite with TypeScript, target `esnext` (required for SurrealDB WASM engine path)
- Univer packages: `@univerjs/presets` + `@univerjs/preset-sheets-core` as baseline; upgrade to full plugin mode only if spike reveals need for deeper command service access
- All `@univerjs/*` packages at identical semver — pin in package.json
- `surrealdb` npm package v2.0.3
- CSS custom properties in `design-system.css` mapping every token from `DESIGN.md`: colors, typography, spacing scale, border radii, motion durations
- Google Fonts import: `Instrument Serif`, `Source Sans 3`, `Geist Mono` (exact URL from DESIGN.md)
- `schema/main.surql`: all DEFINE TABLE/FIELD/ACCESS/INDEX/BUCKET statements from CEO plan; idempotent
- `docker-compose.yml`: single `surreal` service on v3.0.5, RocksDB backend, `restart: unless-stopped`. **SurrealDB command must include `--allow-experimental files`** for DEFINE BUCKET file storage to work.
- `.env.example`: `VITE_SURREAL_URL`, `VITE_SURREAL_NS`, `VITE_SURREAL_DB`, `SURREAL_ROOT_PASS`, `VITE_TURNSTILE_SITE_KEY`

**Patterns to follow:**
- `DESIGN.md` color/typography/spacing tokens — exact hex values, exact font names
- `schema/main.surql` schema from CEO plan sections "Workspace & workbook provisioning", "Mutations table schema", "Snapshot table schema", "Form Definition Schema", "Auth Design"

**Test scenarios:**
- Test expectation: none — pure scaffolding. Verified by: `npm run dev` starts without errors; SurrealDB starts via `docker compose up`; `schema/main.surql` applies without errors via `surreal import`

**Verification:**
- `npm run dev` serves `index.html` without console errors
- `docker compose up` starts SurrealDB and exposes port 8000
- `surreal import schema/main.surql` completes with no errors on a fresh DB

---

- [ ] **Unit 2: SurrealDB Connection Layer + Auth**

**Goal:** Establish the SurrealDB WebSocket connection module, JWT-based authentication (lawyer_access), token persistence, and reconnect/event plumbing that all other units depend on.

**Requirements:** R1, R3

**Dependencies:** Unit 1

**Files:**
- Create: `src/surreal/client.ts`
- Create: `src/surreal/auth.ts`
- Create: `src/surreal/types.ts`
- Create: `src/surreal/client.test.ts`

**Approach:**
- Singleton `db` export from `client.ts`: `new Surreal()` with reconnect config (`enabled: true`, `attempts: -1`, `retryDelayMax: 30_000`)
- `auth.ts`: `signIn(email, password)` stores tokens in memory + `sessionStorage`; `signOut()`; `getTokens()` for re-auth on page reload; subscribe to `db.subscribe('auth', cb)` for token refresh events
- `types.ts`: TypeScript interfaces for Workspace, Workbook, WorkspaceMember, Mutation, Snapshot, FormDefinition, ClientError
- Connection status observable: expose a reactive `connectionState` signal (or EventTarget) so the UI can show "Reconnecting..." banner
- On page load: if session token exists → `db.authenticate(tokens)` → connect; else → show login

**Patterns to follow:**
- SurrealDB SDK `db.connect()` with reconnect options from external research
- `db.subscribe('auth', cb)` for token lifecycle

**Test scenarios:**
- Happy path: valid credentials → `signIn()` returns tokens → `db.authenticate()` succeeds → connection state transitions to `connected`
- Happy path: page reload with valid session token → auto-reconnects without prompting login
- Edge case: expired access token + valid refresh token → `db.authenticate({access, refresh})` exchanges for fresh pair
- Edge case: SurrealDB unreachable → connection state transitions to `reconnecting` → UI can render banner
- Error path: wrong credentials → `signIn()` rejects → auth error surfaced to login form
- Error path: refresh token also expired → `signOut()` called automatically → redirect to login

**Verification:**
- Unit tests cover auth state transitions using a mock Surreal instance
- Manual: login → DB shows `lawyer_access` token issued; disconnect Docker → connection state shows `reconnecting`; restart Docker → auto-reconnects

---

- [ ] **Unit 3: Univer Bootstrap + Workbook Loader**

**Goal:** Mount the Univer spreadsheet on the page, load a workbook's entity table data from SurrealDB into Univer cells, and establish the two-way binding: cell edits → mutations table; mutations table LIVE SELECT → cell updates.

**Requirements:** R2, R3

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `src/workbook/univer.ts`
- Create: `src/workbook/collaboration.ts`
- Create: `src/workbook/snapshot.ts`
- Create: `src/workbook/presence.ts`
- Create: `src/workbook/collaboration.test.ts`

**Approach:**

*Univer bootstrap (`univer.ts`):*
- Mount Univer using `createUniver()` from `@univerjs/presets` with `UniverSheetsCorePreset`
- If Unit 0 spike requires plugin mode for `ICommandService`, use full plugin registration instead
- Load workbook data: `SELECT * FROM {entity_table} WHERE workspace = $ws` → populate Univer sheet rows
- `univerAPI.createWorkbook(snapshotData)` when loading from a snapshot

*Collaboration (`collaboration.ts`):*
- Capture: `univerAPI.addEvent(univerAPI.Event.CommandExecuted, cb)` — filter `event.type === 2 (MUTATION)` AND `!options?.fromCollab`
- Validate: skip if `command_id` not in whitelist Set; skip if `params` empty/undefined
- Write: `db.query('INSERT INTO mutation ...')` with `{workbook_id, command_id, params, client_id, ts: server-assigned}`
- Receive: `db.live(new Table('mutation'))` filtered by `workbook_id`
- Replay: **re-subscribe to LIVE SELECT first and buffer incoming events**; run gap detection query; replay missing mutations via `executeCommand(command_id, params, {fromCollab: true})`; drain buffered events; resume normal LIVE SELECT application. This ordering eliminates the TOCTOU window where mutations arrive between gap detection and re-subscription.
- Retry queue: failed INSERT → queue in memory (cap 500); exponential backoff; warning banner after 50 queued
- Reconnect logic: gap detection query → choose replay or snapshot sync per threshold (>50 mutations OR >30s → snapshot)

*Snapshot (`snapshot.ts`):*
- Coordinator election: write/hold a `presence` record with `client_id` (session-unique UUID from `crypto.randomUUID()`, stored in `sessionStorage`) and `ts`; LIVE SELECT on `presence` to detect active clients; lowest `client_id` is coordinator
- `client_id` must be session-unique, not user-unique: two browser tabs from the same user must have different IDs. Use `crypto.randomUUID()` on session init; store in `sessionStorage` (not `localStorage`) so tabs are independent.
- Coordinator writes snapshot: `fWorkbook.save()` → INSERT into `snapshot` table every 100 mutations or 10 minutes
- **On coordinator failover**: new coordinator must replay all mutations since the last snapshot before writing a new one. Writing immediately on election risks snapshotting a stale state if in-flight mutations have not been applied yet.
- Non-coordinator: LIVE SELECT on `snapshot` table to detect new snapshots; apply if snapshot `ts` > current watermark
- Snapshot load: `SELECT * FROM snapshot WHERE workbook_id = $wb ORDER BY ts DESC LIMIT 1` → `univerAPI.createWorkbook(snapshot.data)` → set `last_ts` watermark

*Reconnect flow:*
- On `db.subscribe('auth')` / connection event: run gap detection → replay or snapshot path
- Snapshot-not-found: cold start — rebuild from entity tables directly

**Patterns to follow:**
- Command whitelist Set from CEO plan section "Command whitelist"
- Mutation/snapshot table schemas from CEO plan

**Test scenarios:**
- Happy path: Tab A edits cell → mutation INSERTed → Tab B LIVE SELECT fires → `executeCommand` replays → cell value matches
- Happy path: coordinator client writes snapshot after 100 mutations → `snapshot` table record exists → new client loads snapshot on connect
- Edge case: Tab A edits same cell as Tab B simultaneously → server `ts` determines winner → both clients converge to same value within 2s
- Edge case: LIVE SELECT fires while Tab A is mid-replay → LIVE SELECT application paused until replay drains
- Edge case: 60 mutations cached during 35s disconnect → reconnect triggers snapshot sync (threshold exceeded) → local mutations discarded, snapshot applied
- Edge case: coordinator disconnects → next-lowest-client-id client takes over snapshot writes within 30s
- Edge case: snapshot JSON corrupted → cold-start rebuild from entity tables
- Error path: mutation INSERT fails 50 times → warning banner shown; queue cap reached at 500 → oldest dropped
- Error path: unknown `command_id` in received mutation → skipped, logged to `client_error` table, immediate snapshot resync triggered

**Verification:**
- `collaboration.test.ts` mocks SurrealDB client and Univer command service; covers all edge cases listed
- Manual two-tab test: edit → sync ≤2s; disconnect one tab → reconnect → state converges

---

- [ ] **Unit 4: GRAPH_TRAVERSE Custom Formula**

**Goal:** Register `GRAPH_TRAVERSE(startNode, relationship, depth)` as an async Univer formula that queries SurrealDB graph edges, returns display labels in the cell, and populates a sidebar panel with the full result list on click.

**Requirements:** R4

**Dependencies:** Unit 2, Unit 3

**Files:**
- Create: `src/formulas/graph-traverse.ts`
- Create: `src/formulas/graph-traverse.test.ts`
- Create: `src/sidebar/graph-results.ts` (sidebar panel component)

**Approach:**
- Register via `univerAPI.getFormula().registerAsyncFunction('GRAPH_TRAVERSE', fn, { description: '...' })`
- `fn(startNode, relationship, depth)`:
  - Validate: `startNode` must be non-empty string record ID; `relationship` must be non-empty string; `depth` must be integer 1–10
  - Batched traversal: each depth level issues ONE query: `SELECT ->{relationship}->{entity_table}.* FROM [$ids]` — `N` queries for depth `N`
  - Workspace scoping: all queries filter by `workspace_id` via SurrealDB permissions (workspace field + PERMISSIONS on entity tables)
  - Cycle detection: maintain visited Set client-side; deduplicate results
  - Display label resolution: priority (1) `name` field, (2) `label` field, (3) first alphabetical `string` field
  - Cell value: first 5 display labels + "(+N more)"; raw record IDs stored as internal formula value for chaining
  - Error tokens: `#REF!` (invalid/deleted record ID), `#NAME?` (unknown relationship), `#VALUE!` (invalid depth), `#TIMEOUT!` (10s query timeout)
- LIVE SELECT reactivity: when entity table changes, mark dependent formula cells dirty → debounce 500ms → recalculate
- Dependency map: `{table_name → Set<formula_cell_refs>}` — only recalculate formulas referencing the changed table
- Query concurrency cap: max 10 concurrent traversal queries; additional queued
- On cell click (formula result cell): open graph-results sidebar panel with full scrollable list (label, record ID, entity type); click row → record detail panel

**Patterns to follow:**
- Univer `registerAsyncFunction` API from external research: `univerAPI.getFormula().registerAsyncFunction(name, fn, options)`
- `@univerjs/sheets/facade` must be imported before `univerAPI.getFormula()` is available — import order matters with `@univerjs/presets` lazy initialization
- Error token conventions from Univer built-in formulas (`#REF!`, `#NAME?`, `#VALUE!`)
- Debounce + dependency map from CEO plan "GRAPH_TRAVERSE Recalculation" section
- Note on LIVE SELECT batch behavior: SurrealDB LIVE SELECT fires per-record, not per-batch. A 500-row CSV import triggers 500 events 50ms apart, which continuously resets the 500ms debounce and delays recalculation. The debounce implementation must use a maximum-wait ceiling (e.g., 2s max delay regardless of reset count) not just a trailing debounce.

**Test scenarios:**
- Happy path: `=GRAPH_TRAVERSE("company:acme", "owns", 2)` → returns comma-separated display labels for all companies owned within 2 hops
- Happy path: cell displays "Acme Corp, Beta LLC, Gamma Inc (+12 more)" when >5 results
- Happy path: click formula cell → sidebar opens with full 15-item list; each row shows label + record ID + entity type
- Happy path: entity record updated in SurrealDB → 500ms debounce → formula cell recalculates with new data
- Edge case: graph has cycle (A→B→C→A) → visited set deduplicates → no infinite loop → correct results without A appearing twice
- Edge case: `depth=10` with 1000-node graph → max 10 concurrent queries → all nodes return eventually (queued, not dropped)
- Edge case: `startNode` is empty string → `#VALUE!`
- Edge case: `depth=0` → `#VALUE!`
- Edge case: `depth=11` → `#VALUE!`
- Error path: record ID deleted since formula entered → `#REF!`
- Error path: relationship type does not exist in schema → `#NAME?`
- Error path: query exceeds 10s timeout → `#TIMEOUT!`
- Integration: `=GRAPH_TRAVERSE(A2, "owns", 3)` where A2 contains a record ID from another cell → correctly resolves and traverses

**Verification:**
- `graph-traverse.test.ts` covers all error tokens, cycle detection, depth validation, label resolution
- Manual: formula returns results in ≤3s for a 10-node graph at depth 3; cycle graph does not hang

---

- [ ] **Unit 5: App Shell + Navigation**

**Goal:** Build the full app shell — top bar, left rail, main canvas, right sidebar — matching the "Workbook View (Main Grid) - surreal_ck style" Stitch screen. Implement routing: login → template picker (new user) or workbook (returning user).

**Requirements:** R1, R12

**Dependencies:** Unit 2, Unit 3

**Files:**
- Create: `src/shell/app-shell.ts`
- Create: `src/shell/top-bar.ts`
- Create: `src/shell/left-rail.ts`
- Create: `src/shell/sidebar-host.ts`
- Create: `src/shell/login.ts`
- Create: `src/shell/reconnect-banner.ts`
- Create: `src/shell/status-bar.ts`

**Approach:**
- App shell layout per DESIGN.md: left rail (collapsible) + sheet canvas (Univer) + contextual sidebar (one panel at a time)
- Top bar: workspace name | workbook name | presence indicators (active user avatars) | Share/Members button | user menu
- Left rail: workbook switcher, template/create workbook, recent changes link, admin entry (admin role only)
- Status bar (bottom): sync state chip (synced/reconnecting/offline), import progress, mutation queue warning
- Login screen: email + password form, `src/shell/login.ts`, matches design aesthetic (Instrument Serif heading, warm neutral background)
- Routing logic: on auth success → check `SELECT * FROM workbook WHERE workspace = $ws ORDER BY ts DESC LIMIT 1`; if result → open it; else → template picker
- Last-workbook-deleted fallback: on workbook load returning not-found → redirect to workspace home with informational banner
- Reconnect banner: listens to connection state from Unit 2; shows "Reconnecting..." with spinner; disappears on reconnect
- Design tokens: all CSS from `design-system.css`; fonts: Instrument Serif for workbook title, Source Sans 3 for labels/nav, Geist Mono for sync state and record IDs
- Sidebar host: slot-based panel system; only one panel open at a time; panels: graph results, record detail, recent changes, admin tools

**Patterns to follow:**
- DESIGN.md layout rules: "left rail + sheet canvas + single contextual sidebar"
- "Workbook View (Main Grid) - surreal_ck style" Stitch screen
- Status chip: mono label, pill shape, restrained fill per DESIGN.md Components

**Test scenarios:**
- Happy path: returning user with existing workbook → login → workbook opens with last-viewed sheet restored
- Happy path: new user → login → template picker shown (no workbook in DB)
- Edge case: last workbook deleted → login → workspace home with "That workbook no longer exists" banner
- Edge case: SurrealDB unreachable on login → "Server unavailable" modal with retry button
- Edge case: admin role user → admin entry visible in left rail; non-admin → admin entry absent
- Edge case: connection drops mid-session → reconnect banner visible; connection restored → banner disappears

**Verification:**
- Visual match to "Workbook View" Stitch screen (design tokens applied, layout correct)
- Keyboard: all sidebar actions, navigation elements are tab-accessible

---

- [ ] **Unit 6: Template Picker + First-Run Experience**

**Goal:** Build the template picker, blank workspace guided setup panel, and the SurrealQL provisioning scripts for each template. New users land here before entering the workbook.

**Requirements:** R11

**Dependencies:** Unit 2, Unit 5

**Files:**
- Create: `src/shell/template-picker.ts`
- Create: `src/shell/guided-setup.ts`
- Create: `schema/templates/legal-entity-tracker.surql`
- Create: `schema/templates/case-management.surql`
- Create: `schema/templates/blank-workspace.surql`

**Approach:**
- Three templates: Legal Entity Tracker (Company/Person/Trust, owns/controls/filed_by edges, sample data + "New Client Intake" form), Case Management (Case/Client/Document, assigned_to/filed_in edges, 3 sample cases), Blank Workspace (empty, opens guided setup)
- Template selection → `db.query(templateScript)` → transactional provisioning (workspace + workbook + entity types + relation types + form definitions + sample records in a single SurrealDB transaction or script)
- Provisioning failure: if any step fails → compensating delete of partial records → user returns to template picker with error banner (no silent broken state)
- Blank workspace: opens workbook immediately + auto-opens guided setup panel in sidebar
- Guided setup panel: exactly 3 actions — (1) Create first entity type, (2) Create first relationship type, (3) Create first intake form. Each links to the corresponding admin sidebar section. Dismissible. Does not auto-open again once workspace has ≥1 entity type + saved workbook activity.
- Template scripts are idempotent and workspace-scoped (all records include `workspace` field)
- Template picker matches "Template Picker (surreal_ck style)" Stitch screen; guided setup matches "Blank Workspace Guided Setup" screen

**Patterns to follow:**
- SurrealDB `BEGIN TRANSACTION; ... COMMIT TRANSACTION;` for atomic provisioning
- Template SURQL pattern from CEO plan "First-Run Experience" section

**Test scenarios:**
- Happy path: select "Legal Entity Tracker" → provisioning runs → workbook opens with 5 companies, action sheet default
- Happy path: select "Blank Workspace" → empty grid opens → guided setup panel auto-opens with 3 actions
- Happy path: complete all 3 guided setup actions → panel can be dismissed → does not reappear on next session
- Edge case: template provisioning fails mid-transaction → partial records cleaned up → user back at picker with error banner
- Edge case: user selects a template while already having a workbook (shouldn't happen per flow, but guard against it)
- Edge case: guided setup panel dismissed before completing all steps → panel state persists across page reloads (use `localStorage`)

**Verification:**
- Manual: new user flow end-to-end; both non-blank templates open with sample data visible in sheet
- Provisioning script: re-running the same template script on an existing workspace is a no-op (idempotent)

---

- [ ] **Unit 7: Admin Sidebar**

**Goal:** Build the admin sidebar panel with four sections: Entity Types, Relationship Types, Form Builder, Workspace Members. Admin-only, renders inside the right sidebar slot.

**Requirements:** R7

**Dependencies:** Unit 5, Unit 2

**Files:**
- Create: `src/admin/admin-sidebar.ts`
- Create: `src/admin/entity-types.ts`
- Create: `src/admin/relation-types.ts`
- Create: `src/admin/form-builder.ts`
- Create: `src/admin/workspace-members.ts`
- Create: `src/admin/admin-sidebar.test.ts`

**Approach:**
- Permission gate: sidebar renders only for `workspace_member.role === "admin"`; non-admin users see nothing
- **Entity Types**: list, create, edit, delete. Create → executes `DEFINE TABLE + DEFINE FIELD` statements via `db.query()`; schema sync validation runs after (verify table exists via `INFO FOR DB`); DDL failure shown as inline sidebar error with failed step identified + "Try again" action
- **Relationship Types**: list, create, edit, delete edge type definitions. Edge types stored as `relation_type` records in SurrealDB (not raw DEFINE TABLE — edge table defined dynamically on first RELATE)
- **Form Builder**: create/edit `form_definition` records. Field list with drag-and-drop ordering (HTML drag events, no library). Field types from `field_type` table. Conditional rules editor. `auto_relations` editor. Preview button opens rendered form in a modal
- **Workspace Members**: invite (email → create `workspace_member` record), list members with role, remove, change role (admin/editor/viewer)
- DDL partial failure: treat entity creation as atomic; if multi-statement DDL fails at any step, report which step failed; do not leave orphaned partial schema
- Health panel (admin): queries from CEO plan observability section — mutations today, active workbooks, last snapshot per workbook, recent errors, file storage
- Matches "Admin Sidebar Configuration - surreal_ck style" Stitch screen

**Patterns to follow:**
- CEO plan "Admin UI Design" section for section list and permission gate
- CEO plan "Field Type Registry" for `field_type` table query
- SurrealDB `INFO FOR DB` for post-DDL schema validation

**Test scenarios:**
- Happy path: admin creates entity type "Investor" with 3 fields → DDL executes → `INFO FOR DB` confirms table exists → list updates
- Happy path: admin invites user by email → `workspace_member` record created → new member appears in list
- Happy path: form builder creates `form_definition` with 4 fields and 1 conditional rule → record saved → preview renders correctly
- Edge case: non-admin user attempts to access admin sidebar → permission gate blocks; no DDL queries issued
- Error path: `DEFINE TABLE` succeeds but `DEFINE FIELD` step fails → inline sidebar error names the failed step → entity type NOT in the list (rolled back or cleaned up)
- Error path: invite email already a member → show "Already a member" error inline; no duplicate record
- Edge case: DDL execution with a reserved table name → SurrealDB rejects → error surfaced clearly (not raw DB message)

**Verification:**
- `admin-sidebar.test.ts` mocks SurrealDB client; covers permission gate, DDL success/failure, member management
- Manual: admin creates an entity type → navigates to the new workbook sheet → sheet is empty but table exists in DB

---

- [ ] **Unit 8: Public Intake Form**

**Goal:** Build the public intake form page — a static page with no login required. Submits data directly to SurrealDB via `form_submit` access. Handles file uploads via SurrealDB bucket. Shows a dedicated confirmation state.

**Requirements:** R5, R6

**Dependencies:** Unit 2, Unit 1

**Files:**
- Create: `src/forms/intake-form.ts`
- Create: `src/forms/file-upload.ts`
- Create: `src/forms/confirmation.ts`
- Create: `src/forms/intake-form.test.ts`

**Approach:**
- Standalone static page (`/form/:formId`) — does not require lawyer auth
- Loads `form_definition` from SurrealDB via `form_submit` access (read-only for definition; write-only for target table)
- Renders fields dynamically from `form_definition.fields`: text, number, date, single_select, multi_select, file
- Conditional rules: show/hide fields based on `conditional_rules` array
- Form draft auto-save: `localStorage` keyed by `formId` — restore on reload
- Cloudflare Turnstile: client-side CAPTCHA verification before submit; if Turnstile API times out (network error, NOT bot rejection) → allow submission and log as unverified
- **Submission flow**: generate submission token (UUID) on form load → disable submit button on first click → validate all required fields → validate stale FK references (`SELECT id FROM {target_table} WHERE id = $id` for each `auto_relations` target) → `BEGIN TRANSACTION; LET $record = CREATE ...; RELATE $record->{edge_type}->{target}; COMMIT` → if any step fails → transaction rolls back → user sees inline error
- File upload: before transaction → sanitize filename (strip path separators `/`, `..`, null bytes; UUID-prefix to ensure uniqueness) → `db.query('LET $f = f"spreadsheet_files:/{uuid}-{sanitized_name}"; $f.put($bytes)')` → store file path in form field value → include in record creation transaction → if transaction fails → `$f.delete()` to clean up orphan
- **File upload proof-of-concept required early in Unit 8**: passing a browser `File` as `ArrayBuffer` via `db.query()` parameters has no documented SDK example. Verify this works before building the full form submission flow around it. If not viable, fall back to a base64-encoded string approach.
- File size: enforce 20MB limit client-side; show "File too large. Maximum size: 20MB." if exceeded
- Duplicate submission prevention: submission token stored as unique field; if duplicate → SurrealDB rejects → show "Submission already received" (no silent double-insert)
- Confirmation state: dedicated full-page confirmation (not just toast) showing: submission timestamp, summary of key fields, attachment names, "what happens next" message. Matches "Public Intake Submission Confirmation" Stitch screen
- Stale FK error: show inline field error "Referenced entity no longer exists. Please refresh and try again."

**Patterns to follow:**
- `form_submit` DEFINE ACCESS from CEO plan
- SurrealDB bucket file syntax from external research (`f"bucket:/path"`)
- `BEGIN TRANSACTION ... COMMIT TRANSACTION` atomicity from CEO plan

**Test scenarios:**
- Happy path: complete form with all fields + file → submit → transaction commits → confirmation page shown
- Happy path: form draft auto-saved to localStorage → reload page → fields pre-populated
- Happy path: Turnstile verification passes → submission proceeds
- Edge case: Turnstile API times out → submission proceeds with `unverified=true` logged
- Edge case: Turnstile bot rejection → "Verification failed. Please try again." shown
- Edge case: file >20MB → client-side rejection before submit attempt
- Edge case: `auto_relations` target record deleted → inline error on stale field before submit
- Edge case: submit button clicked twice rapidly → second click is no-op (button disabled after first)
- Error path: transaction fails mid-commit → orphaned file cleaned up → user sees "Submission failed, please try again."
- Error path: SurrealDB unreachable → "Server unavailable" full-page error with retry
- Integration: form submitted → row appears in lawyer's Univer grid via LIVE SELECT within 2s (requires Unit 3)

**Verification:**
- `intake-form.test.ts` covers validation, transaction atomicity mock, file cleanup on failure, duplicate token rejection
- Manual end-to-end: submit form → row appears in workbook; submission with file → file retrievable from bucket

---

- [ ] **Unit 9: Form Submission Toast + Row Highlight**

**Goal:** When a public form submission arrives via LIVE SELECT, show a toast notification in the lawyer's workbook and highlight the new row in the grid.

**Requirements:** R5

**Dependencies:** Unit 3, Unit 8

**Files:**
- Modify: `src/workbook/collaboration.ts` (add form submission LIVE SELECT)
- Create: `src/shell/toast.ts`
- Modify: `src/workbook/univer.ts` (add row highlight logic)

**Approach:**
- LIVE SELECT on entity tables (filtered by workspace): when `action === 'CREATE'` and source is a form submission (detect via presence of submission token field) → fire toast
- Toast: non-blocking, auto-dismisses after 5s. Content: "New submission: [form title]" + submitter name if captured. Matches DESIGN.md motion/duration (short: 120–180ms enter/exit)
- Row highlight: newly inserted row gets a temporary background color (warning amber from design system) for 3s, then fades out
- Toast accessible via live region (`aria-live="polite"`)

**Test scenarios:**
- Happy path: form submitted → toast appears in lawyer's workbook within 2s → row highlighted in grid
- Edge case: multiple submissions arrive within 1s → each gets a toast (stacked or sequenced, not dropped)
- Edge case: lawyer's tab in background → toast queued; shows when tab focused (browser notification API out of scope for MVP)

**Verification:**
- Manual: submit form from one browser → workbook in another browser shows toast + highlighted row

---

- [ ] **Unit 10: CSV Import**

**Goal:** Allow admins/editors to import CSV files into entity tables: upload → column mapping → dry-run preview with validation → commit in 500-row chunks with progress bar.

**Requirements:** R8

**Dependencies:** Unit 2, Unit 7

**Files:**
- Create: `src/import/csv-import.ts`
- Create: `src/import/column-mapping.ts`
- Create: `src/import/import-preview.ts`
- Create: `src/import/csv-import.test.ts`

**Approach:**
- Upload: file input accepts `.csv` files; parsed client-side (no server needed)
- Formula injection prevention: strip leading `=`, `+`, `-`, `@`, `\t`, `\r` from all cell values before processing; show post-import banner if any cells were sanitized
- Column mapping: map CSV headers to entity table field names; supports skip column, custom field name, type coercion per `field_type` table
- Dry-run preview: validate first 50 rows (type errors, required field violations, FK reference checks); show validation summary with error count and first 5 errors; user cannot commit if validation errors present (unless they choose "skip invalid rows")
- Commit: INSERT in 500-row SurrealDB transactions; progress bar shows `N / total rows`; if any chunk fails → stop import, report which chunk, show repaired-rows interface
- Partial failure strategy: fail entire import (rollback all committed chunks); show which rows failed; user corrects and re-uploads (legal context: partial import worse than full rollback)
- Matches "CSV Import Workspace", "Import Field Mapping", "Import Validation Results", "Import Commit Confirmation", "Import Error Repair" Stitch screens

**Patterns to follow:**
- Batched SurrealDB inserts in 500-row chunks from CEO plan
- Formula injection prevention list from CEO plan item 24

**Test scenarios:**
- Happy path: 100-row clean CSV → mapping → no validation errors → commit → all 100 rows in DB
- Happy path: progress bar updates after each 500-row chunk during large import
- Edge case: CSV cell starts with `=SUM(A1)` → sanitized to `SUM(A1)` → post-import banner shows "1 cell contained formula characters and was escaped"
- Edge case: 5000-row import → 10 chunks → progress reaches 100% → all rows present
- Edge case: column in CSV not mapped to any field → warn user; allow "skip column"
- Error path: 3 rows have type errors (text in number field) → dry-run shows errors → commit blocked → user corrects CSV and re-uploads
- Error path: chunk 3 of 10 fails during commit → import stops → user sees "Import failed at row 1001. Rows 1–1000 were not committed." (full rollback)

**Verification:**
- `csv-import.test.ts` covers formula injection, chunk batching, partial failure rollback, validation errors
- Manual: 5000-row import with 3 invalid rows → validation catches them; clean import → all rows visible in workbook

---

- [ ] **Unit 11: Recent Changes Sidebar**

**Goal:** Show a "Recent Changes" panel in the left rail / right sidebar with the last 20 mutations across the workbook — who changed what and when.

**Requirements:** R3 (collab UX)

**Dependencies:** Unit 3

**Files:**
- Create: `src/sidebar/recent-changes.ts`

**Approach:**
- Query: `SELECT command_id, params, client_id, ts FROM mutation WHERE workbook_id = $wb ORDER BY ts DESC LIMIT 20`
- Display: scrollable list; each item shows: action summary (derived from `command_id` + `params`), user display name (resolved from `client_id` → user record), relative timestamp ("2 min ago")
- LIVE SELECT on `mutation` table → new entries prepend to list automatically
- Unresolved actor names (deleted user, form submission): show `client_id` as fallback in Geist Mono
- Empty state: "No recent changes yet" with explanation
- Error state: inline retry
- Matches "Activity Timeline Audit Log - surreal_ck style" Stitch screen

**Test scenarios:**
- Happy path: 5 mutations exist → panel shows 5 rows with action, user, timestamp
- Happy path: new mutation arrives → prepends to list live (LIVE SELECT)
- Edge case: `client_id` has no matching user record → show `client_id` in mono as fallback
- Edge case: `command_id` is an unrecognized string → show "Unknown action" gracefully
- Empty state: no mutations yet → "No recent changes yet" message shown

**Verification:**
- Manual: two users editing → recent changes panel updates in real-time for both

---

- [ ] **Unit 12: Record ID Interactions (Hover Preview + Relationship Creator + Autocomplete)**

**Goal:** Three UX enhancements that make record IDs feel native: (1) hover a record ID in a cell → tooltip with entity key fields; (2) right-click two rows → "Create Relationship" context menu; (3) formula autocomplete for `GRAPH_TRAVERSE` record ID argument.

**Requirements:** R4 (CEO scope expansion items 1, 2, 4)

**Dependencies:** Unit 3, Unit 4

**Files:**
- Create: `src/workbook/record-hover.ts`
- Create: `src/workbook/relationship-creator.ts`
- Create: `src/workbook/formula-autocomplete.ts`

**Approach:**
- **Hover preview**: detect cells containing record IDs (matching SurrealDB record ID pattern `table:id`); on hover after 300ms delay → fetch entity record → show tooltip with key fields (name/label/first string field); dismiss on mouse-leave
- **Relationship creator**: right-click on selected row(s) in a sheet → context menu item "Create Relationship" → modal: choose relationship type + target row/record → `RELATE $source->{edge_type}->{target}` → success toast
- **Formula autocomplete**: when editing a cell starting with `=GRAPH_TRAVERSE(`, and cursor is in the `startNode` argument position → suggest record IDs from entity tables in workspace (autocomplete dropdown with entity name + ID)
- Copy graph path: right-click GRAPH_TRAVERSE result cell → "Copy as text" → clipboard gets resolved display names joined with "→"

**Test scenarios:**
- Happy path: cell contains `company:acme` → hover 300ms → tooltip shows "Acme Corp / Type: LLC / Jurisdiction: Delaware"
- Happy path: select two rows → right-click → "Create Relationship" → choose "owns" → `RELATE` executes → success toast
- Happy path: type `=GRAPH_TRAVERSE(` → autocomplete dropdown appears with entity IDs; select one → ID inserted
- Edge case: hover record ID that no longer exists → tooltip shows "Record not found" gracefully
- Edge case: right-click on non-entity row → "Create Relationship" absent from context menu

**Verification:**
- Manual: full hover/right-click/autocomplete flow works in the workbook

---

- [ ] **Unit 13: Backup Script + Deployment**

**Goal:** Production deployment: Docker Compose, schema init, backup cron script with 30-day retention and failure logging, and smoke check runbook.

**Requirements:** R10, R9

**Dependencies:** All prior units

**Files:**
- Create: `backup.sh`
- Create: `scripts/init-schema.sh`
- Modify: `docker-compose.yml` (finalize with nginx for static assets)
- Create: `nginx.conf`
- Create: `DEPLOYMENT.md`

**Approach:**
- `backup.sh`: `surreal export` to `/data/backups/surreal_ck_TIMESTAMP.surql`; retain last 30 days (`find -mtime +30 -delete`); log failure to `/var/log/surreal_ck_backup.log`; cron: `0 2 * * *`; mutation cleanup after backup (`DELETE mutation WHERE ts < oldest_snap_ts`)
- `scripts/init-schema.sh`: runs `surreal import schema/main.surql` on deploy; safe to re-run (idempotent)
- `docker-compose.yml`: `surreal` service (RocksDB, `restart: unless-stopped`) + `nginx` service serving Vite build from `/dist`; nginx enforces `client_max_body_size 25m`
- `nginx.conf`: serve static assets, SPA fallback (`try_files $uri /index.html`), `client_max_body_size 25m`. **Must include WebSocket proxy block** for the SurrealDB port so browsers can reach SurrealDB through nginx rather than requiring SurrealDB's port to be publicly exposed (security: only nginx port exposed, SurrealDB port internal-only in Docker network). Use `proxy_pass`, `proxy_http_version 1.1`, `Upgrade`/`Connection` headers for WS upgrade.
- Post-deploy smoke checks documented in `DEPLOYMENT.md`:
  1. Spreadsheet loads without error
  2. Cell edit → mutation in DB
  3. Two-tab sync within 2s
  4. GRAPH_TRAVERSE formula returns results
  5. Public form → submit → row appears in grid

**Test scenarios:**
- Test expectation: none — infrastructure/config. Verified by smoke checks.

**Verification:**
- `backup.sh` runs without error on a live DB; backup file exists in `/data/backups/`; re-running `init-schema.sh` on existing schema produces no errors
- Smoke check list in `DEPLOYMENT.md` all pass on fresh deployment

---

## System-Wide Impact

- **Interaction graph:** LIVE SELECT subscriptions (managed via `db.live()`) touch mutations, snapshots, entity tables, presence, and form submission tables. Any unit that adds a new LIVE SELECT must register a cleanup handler (`live.kill()` on unmount). Unhandled live queries accumulate and degrade performance.
- **Error propagation:** All SurrealDB query failures in the collab layer log to `client_error` table (Unit 2 connection layer). Formula errors surface as Univer error tokens (`#REF!`, `#TIMEOUT!`). Transaction failures surface as user-facing inline errors, never raw SurrealDB messages.
- **State lifecycle risks:** Template provisioning (Unit 6) and DDL execution (Unit 7) are the highest-risk write operations. Both must be transactional or compensating-delete on failure. File uploads (Unit 8) must be cleaned up if the parent transaction rolls back.
- **API surface parity:** Admin sidebar DDL operations are the only place where schema is mutated at runtime. All other units are DML only. Schema changes via the admin sidebar must be followed by `INFO FOR DB` validation.
- **Integration coverage:** The core LIVE SELECT → cell update path spans Units 2, 3, and 8 and cannot be fully covered by unit tests alone. The two-tab manual smoke check (Unit 3) and the form → grid E2E test (Unit 8/9) are mandatory integration verification steps.
- **Unchanged invariants:** `schema/main.surql` is the source of truth for all statically-defined tables. Dynamic entity tables created via admin DDL are additive and do not change the static schema. The mutation replay whitelist (a client-side Set in `collaboration.ts`) is intentionally immutable at runtime — adding new command types requires a code change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Univer `executeCommand` replay fails for some mutation types (spike risk) | Week 0 spike with defined fallback chain: partial failure → snapshot broadcast for failed types; complete failure → periodic snapshot sync; nuclear → single-user MVP |
| All `@univerjs/*` packages must share identical semver | Pin all versions in `package.json` with exact version (no `^`); add a postinstall check script |
| SurrealDB 3.0 live query DELETE events don't return full record body | Use CREATE events for new row detection; avoid relying on DELETE event payload content |
| Snapshot coordinator election race window (two coordinators briefly) | Harmless per design (both write same state); only one snapshot retained (latest) during daily cleanup |
| File storage orphan accumulation | File upload + row insert atomic in Unit 8; cleanup on transaction failure |
| Template provisioning partial failure leaves broken workspace | SurrealDB transaction wraps all provisioning; compensating delete on failure; user returns to picker |
| `syncOnly` Univer mutations bypass `onCommandExecuted` | Verify in spike; add `onMutationExecutedForCollab` subscription if needed |
| Vite `optimizeDeps` issue with `@surrealdb/wasm` if Web Worker path taken | `vite.config.ts` must exclude `@surrealdb/wasm` from optimization; document in setup notes |
| GRAPH_TRAVERSE depth bounding in SurrealDB 3 with cycles | Verify SurrealDB traversal semantics in spike; client-side visited Set implemented regardless as safety net |

## Documentation / Operational Notes

- `DEPLOYMENT.md` covers schema init, rollback procedure (≤5 min, max 24h data loss), smoke checks, and operational runbook (sync issues, disk monitoring)
- `schema/main.surql` is the definitive schema record; any production schema drift should be reconciled against it
- `docs/solutions/` should be seeded after completing each major system (collab, GRAPH_TRAVERSE, forms, admin DDL) via `ce-compound`

## Phased Delivery

### Week 0
- Unit 0: Spike — validate Univer mutation replay

### Week 1 (Core workbook shell)
- Unit 1: Scaffold + design system
- Unit 2: SurrealDB connection + auth
- Unit 3: Univer bootstrap + collaboration
- Unit 4: GRAPH_TRAVERSE formula
- Unit 5: App shell + navigation

### Week 2 (Forms, admin, imports)
- Unit 6: Template picker + first-run
- Unit 7: Admin sidebar
- Unit 8: Public intake form + file upload
- Unit 9: Form toast + row highlight
- Unit 10: CSV import
- Unit 11: Recent changes sidebar
- Unit 12: Record ID interactions
- Unit 13: Backup + deployment

**Week 2 is 8 units and is heavier than Week 1.** Priority order if schedule slips (must-have → nice-to-have):
1. Unit 8: Public intake form (core product hypothesis)
2. Unit 6: Template picker (first-run experience)
3. Unit 13: Backup + deployment (required to ship)
4. Unit 7: Admin sidebar (required for ongoing workspace management)
5. Unit 9: Form toast + row highlight (high-value UX, low effort)
6. Unit 10: CSV import (onboarding accelerator)
7. Unit 11: Recent changes sidebar (collab UX)
8. Unit 12: Record ID interactions (UX polish, lowest risk to defer)

**Minimum shippable MVP**: Units 0–9 + 13. Units 10–12 can ship in v1.1 without blocking launch.

## Sources & References

- **Origin document:** CEO plan at `ceo-plans/2026-04-05-graph-spreadsheet-mvp.md` (absolute path for reference only — treat as external doc)
- Design system: `DESIGN.md`
- Engineering backlog: `TODOS.md`
- Stitch designs: project ID `3112663124167495317` (24 screens)
- Univer docs: https://univer.ai/guides/sheets/getting-started/installation
- SurrealDB JS SDK v2 docs: https://surrealdb.com/docs/sdk/javascript
- SurrealDB 3.0 file storage: https://surrealdb.com/docs/surrealdb/querying/statements/define/bucket

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 8 scope proposals, 8 accepted, 1 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | ISSUES_OPEN (PLAN) | 12 issues, 5 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | started (incomplete) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 unresolved decisions (all findings are documented for implementer action)

**CRITICAL GAPS (no test + no error handling + silent failure):**
1. `fromCollab` suppression not verified in open-source Univer — spike test must include loop prevention check
2. LIVE SELECT reconnect TOCTOU window — mutation silently missed between gap-query and re-subscribe
3. CSV cross-chunk atomicity — plan claims full rollback but multi-transaction chunks cannot be rolled back
4. File upload disk-full — silent failure on legal document (TODOS.md item not handled in Unit 8)
5. SurrealDB port + nginx WebSocket proxy gap — production deployment leaves DB port potentially exposed

**VERDICT:** ENG REVIEW OPEN — 5 critical gaps require resolution before implementation of Units 3, 8, and 10. Unit 0 spike must include `fromCollab` loop prevention test. Run `/plan-eng-review` again after gaps are addressed.
