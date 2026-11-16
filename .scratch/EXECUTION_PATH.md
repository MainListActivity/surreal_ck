# .scratch issue execution path

Updated: 2026-11-15 (basis: `origin/main` at 7263024b)

This file is the canonical scheduling order for the next agents. The web-only pivot spine, the virtual employee runtime (VER-01..06), the virtual office (VO-01..06), the platform legal content MCP (including `07-mcp-oauth`), the claims-vertical issue split, `SHADCN-04`, `WP-B-06`, the legal data product wayfinder decision tickets, and the native resource quota control plane (SCK-NQ-01..10) are all marked `Status: done` in their ticket files, and their implementation is on `main`. Do not re-dispatch implementation for them. What remains is evidence hardening and operations, listed under "Open items".

## Non-negotiable constraints

- Do not revive Electrobun, sidecar windows, external WebView research windows, renderer/main RPC, service JWT, NS-admin, backend business CRUD proxies, or SurrealDB LIVE forwarding.
- Use `pnpm` only.
- Code lives in `server/`, `web/`, `shared/`, `ops/`, `marketing/`; there are no legacy folders left.
- Business data reads/writes default to browser direct SurrealDB. Allowed backend exceptions are the Workspace Scope Module, Mastra `/api/chat*`, resource save confirmation SSE, the employee/office runtime, the ops MCP and content endpoints, and root maintenance paths.
- Employees write office records with employee `$auth` and DML only; any DDL is executed by the issuing human's browser admin session.
- Mastra implementation work must load the `mastra` skill first.
- SurrealQL implementation work must load the `surrealql` skill first and follow the project SurrealDB rules. If the skill is unavailable, say so and verify against existing ADR/schema patterns before writing schema.
- Implementation work follows the `tdd` skill: one public-interface behavior test, then the minimum implementation, then the next behavior. Do not write broad horizontal test suites ahead of implementation.

## Current inventory

- Implementation complete (ticket header `Status: done`, code on `main`): `virtual-employee-runtime` VER-01..06; `virtual-office` VO-01..06; `legal-content-mcp` 01..10 (07 included); `claims-vertical` 01..06 (issues already split from the PRD); `shadcn-migration` 01..04; `server-skeleton` WP-B-06; `legal-data-product-wayfinder` 01..12; `native-resource-quota` 01..10.
- Open, evidence or operations only (no new code tickets): see "Open items".
- Ticket text is historical. Some tickets disagree with themselves: a header `Status: done` with a body `**Status:** ready-for-agent` (VER-01, VER-03, VO-01), or unchecked acceptance boxes (see Open items). Treat those as bookkeeping, not as new work. Reconcile them only in a separate change that is authorized to edit the tickets.
- Other `.scratch/` folders were not re-audited in this update.

## Phase 1: Virtual employee runtime (complete in code)

Reference: `.scratch/virtual-employee-runtime/PRD.md` (its header still says `ready-for-agent`; not reconciled here).

1. `VER-01` shared execution context seam: done. `server/ai/office/employee-runtime.ts`, `employee-runtime.test.ts`.
2. `VER-02` idempotent employee lifecycle and session registration: done. Implementation note dated 2026-09-30 in the ticket; `server/src/routes/employees.ts`, `server/src/db/employee-lifecycle.integration.test.ts`. Open: the retire-rotation checkbox (ticket line 17) is unchecked even though the note records it.
3. `VER-03` generic durable trigger runtime (takes over the daily claims-risk employee): done. `server/ai/office/employee-trigger-runtime.ts`, `employee-trigger-runtime.integration.test.ts`, `server/src/db/daily-claims-risk.integration.test.ts`.
4. `VER-04` durable execution windows and idempotent side effects: done. `employee-trigger-runtime.ver04.integration.test.ts`.
5. `VER-05` budget, loop, retry, and global backpressure: done. `employee-trigger-runtime.ver05.test.ts`, `employee-trigger-runtime.ver05.integration.test.ts`.
6. `VER-06` connection supervision, observability, capacity: done in code. Implementation record in the ticket; `employee-supervisor.ts`; `employee-trigger-runtime.ver06*.test.ts`; `GET /api/ops/employee-runtime/health`. The capacity figures come from a single-instance test over an in-memory fake session layer. They are not production capacity data.

Gate status:

- The code-side gates above are covered by the named tests.
- Production-side gates have no recorded run in the repo. The runbook `docs/runbooks/employee-runtime-observation.md` says a successful scripted run is not production acceptance. It also says VER-06 renewal, reconnect, capacity, and long-term operation are not accepted, and that QA still has to revalidate in production. Treat these as unverified until QA records a run.

## Phase 2: Virtual office (complete in code)

Reference: `.scratch/virtual-office/PRD.md` (header still says `ready-for-agent`; not reconciled here). The office ADR `docs/adr/virtual-office.md` was updated for onboarding, notification generalization, and browser-confirmed DDL (VO-06 acceptance).

1. `VO-01` office domain tables and generalized `user_notification` channel: done. `shared/sql/workspace-template/031-office-domain.surql`, `044-notification-generic-purpose.surql`, `server/src/db/office-domain.integration.test.ts`. Open: body status line stale; acceptance boxes unchecked.
2. `VO-02` project-manager dispatch-to-report tracer: done. `server/ai/office/project-manager.ts`, `office-vertical.integration.test.ts`.
3. `VO-03` human request once-only resolution loop: done. Note dated 2026-10-01 (resume fix for `waiting_on`/`requestId`); `041-office-request-resolution.surql`, `office-request.integration.test.ts`.
4. `VO-04` office live roster and activity page: done per header and body status, but all seven acceptance boxes are unchecked. Code: `web/src/screens/OfficeScreen.svelte`, `web/src/lib/office-runtime.ts` and its test. Acceptance evidence is not recorded in the ticket.
5. `VO-05` analyst-proposed, browser-admin-confirmed DDL: done. `045-office-analyst-ddl.surql`, `server/ai/office/analyst-ddl.integration.test.ts`, `web/src/components/OfficeDdlCard.svelte`.
6. `VO-06` idempotent onboarding from workspace creation to first report: done; all acceptance boxes checked. `POST /api/workspaces/:slug/office/bootstrap` (`server/src/routes/office.ts`), `web/src/lib/office-onboarding.ts` and its test, `046-office-onboarding.surql`. No production onboarding run is recorded.

Gate status:

- Code-side gates are covered by the tests above.
- The production claims-risk reminder, inbox, and an end-to-end office run have no recorded production evidence in the repo.

## Parallel slices

- `claims-vertical`: issues 01..06 exist and are `done`, so the earlier "needs `/to-issues` first" note is obsolete. The PRD header still says `ready-for-agent`. Open: acceptance boxes are unchecked on 01, 05, and 06. Issue 06 is the end-to-end acceptance, and no run is recorded.
- `SHADCN-04`: done, all boxes checked. Its prerequisites 01..03 are `done`, but their acceptance boxes are unchecked.
- `WP-B-06`: done. Closeout note dated 2026-09-29 records a local podman build (158MB) and `/health` check. The CI `quality-gate` `docker build .` step keeps guarding it. No Docker-daemon re-run is recorded; this does not block anything.

## Operations-only remainders

Not implementation work; do not open code tickets for them.

- Native quota production rollout: code tickets SCK-NQ-01..10 are done. The production rollout (maintenance window, ledger backfill, cohort promotion, 24h/48h observation windows, product cutover, 30-day delayed cleanup) follows `docs/runbooks/native-quota-release-cutover.md` and `docs/runbooks/native-quota-legacy-migration.md`. The last recorded status is "production execution not started" in `TODOS.md` (dated 2026-09-18). It cannot be verified from the repo, so ops must confirm the current state.
- `legal-content-mcp` 07: done. `10-codex-e2e.md` records a production run on 2026-09-11 against `https://l.maplayer.top/api/ops/mcp` (DCR, PKCE, scope, refresh, reconnect, and refresh/access revocation; `--fixture --publish --full-lifecycle`, `ok=true`, 0 failures). This update did not re-run it. `TODOS.md` still says "open"; that is stale.
- `legal-data-product-wayfinder` 09..12: done decision tickets. No implementation follows from them.

## Open items (evidence, not implementation)

1. VER-06 production QA revalidation (renewal, reconnect, capacity, long-term operation). Owner: QA with ops access. Per the runbook.
2. VO-04 acceptance: seven boxes unchecked. Needs evidence (tests or a browser run) before office roster acceptance is claimed.
3. VO-06 production onboarding: no production run recorded. Acceptance is unknown in production.
4. claims-vertical 01/05/06 acceptance boxes, including the 06 end-to-end manual run. Needs evidence.
5. Ticket bookkeeping: header vs body status mismatch (VER-01, VER-03, VO-01); unchecked boxes (VER-02 line 17, VO-01/04, claims 01/05/06, shadcn 01..03). Fix only in an authorized ticket-hygiene change.
6. Native quota production rollout status (see Operations-only remainders).

Code completion is not production acceptance. Do not report a production result from a ticket's `done` header alone.

## How each next agent should work

Before editing:

1. Read `AGENTS.md`, `CONTEXT.md`, and the relevant PRD + issue file.
2. Read the ADRs named in that PRD.
3. Confirm the issue belongs to the current phase and its dependencies are merged.
4. If the issue writes Mastra code, load the `mastra` skill first.
5. If the issue writes schema or SurrealQL, load the `surrealql` skill first; if it is unavailable, verify against existing schema patterns.
6. Name the first observable behavior before editing production code.
7. Before re-dispatching any item in Phase 1, Phase 2, or the MCP ticket, show a failing test or a production record that contradicts the current evidence. Otherwise it is already delivered.

During implementation:

- Keep the issue's write scope narrow.
- Prefer integration tests that prove the user-visible boundary: HTTP status, SSE/WS event shape, db rows, permissions, and browser state.
- Use vertical tracer bullets: one failing behavior test, make it pass, then continue.
- Do not add application-level permission filters where schema permissions already enforce access.
- Do not use root for business writes.

Before handoff:

- Run the smallest meaningful checks for the touched workspace, plus `pnpm lint` and `pnpm typecheck`.
- Run `pnpm test` when touching shared/server public behavior, and include the focused package test command in the handoff.
- Update the issue status and note any changed assumptions.
- If a downstream issue's dependency is now satisfied, say so explicitly.
