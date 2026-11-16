# .scratch issue execution path

Updated: 2026-11-16 (basis: `origin/main` at 7263024b; corrected after checking ticket files, `main` paths, PR history, and QA round-01 findings)

This file is the canonical scheduling order for the next agents.

Current entry point: no code ticket is open for dispatch in the virtual employee runtime (VER-01..06), the virtual office (VO-01..06), or the platform legal content MCP (`legal-content-mcp` 01..10, including `07-mcp-oauth`). Their implementation is on `main`. Next work is evidence collection, ticket bookkeeping, and operations, listed under "Open items" and "Operations-only remainders".

A ticket header `Status: done` means the implementation was recorded as complete. It does not mean acceptance boxes are checked, and it does not mean production acceptance. Do not re-dispatch implementation for these tickets. Do not report a production result from a header alone.

## Non-negotiable constraints

- Do not revive Electrobun, sidecar windows, external WebView research windows, renderer/main RPC, service JWT, NS-admin, backend business CRUD proxies, or SurrealDB LIVE forwarding.
- Use `pnpm` only.
- Code lives in `server/`, `web/`, `shared/`, `ops/`, `marketing/`; there are no legacy folders left.
- Business data reads/writes default to browser direct SurrealDB. Allowed backend exceptions are the Workspace Scope Module, Mastra `/api/chat*`, resource save confirmation SSE, the employee/office runtime, the ops MCP and content endpoints, and root maintenance paths.
- Employees write office records with employee `$auth` and DML only; any DDL is executed by the issuing human's browser admin session.
- Mastra implementation work must load the `mastra` skill first.
- SurrealQL implementation work must load the `surrealql` skill first and follow the project SurrealDB rules. If the skill is unavailable, say so and verify against existing ADR/schema patterns before writing schema.
- Implementation work follows the `tdd` skill: one public-interface behavior test, then the minimum implementation, then the next behavior. Do not write broad horizontal test suites ahead of implementation.

## Gates and red lines (restored from origin/main 7263024b)

These are the gates and red lines from the `origin/main` version of this file, plus the claims-vertical highest constraint from its PRD. They still apply. Do not weaken them.

Phase 1, virtual employee runtime:

- Router workflow output, tool permissions, and stream events are unchanged after `VER-01` (ticket title: "保持 Router 零回归").
- Employee sessions are opened and closed by lifecycle transitions. Root is only used for the workspace index and employee credentials.
- The existing daily claims-risk reminder still reaches users, now through the generic trigger runtime.
- A crashed process re-establishes active, waiting, and suspended runs without duplicating business side effects.
- Limits emit a structured runtime signal instead of silently widening.

Phase 2, virtual office:

- The shipped daily claims-risk reminder and inbox keep working while `user_notification` generalizes.
- Employees write office records with employee `$auth` and DML only. Any DDL is executed by the issuing human's browser admin session.
- Office UI reads through browser direct SurrealDB LIVE, never backend LIVE forwarding.
- Budget and loop guards from `VER-05` prevent infinite task loops in a deterministic test.

Claims vertical (highest constraint, from `.scratch/claims-vertical/PRD.md`, "Further Notes"):

- Repository code, platform schema, and platform prompts must not contain legal domain vocabulary. All legal vocabulary stays in `workbook_template` rows. Legal content must be removable as a whole by not seeding the template package or by deleting its template rows.

Evidence for these gates is the named tests in items 1–6 of each phase. No gate is verified as a whole in this file, and no production gate is verified.

## Current inventory

- Implementation recorded complete (ticket header `Status: done`, code on `main`): `virtual-employee-runtime` VER-01..06; `virtual-office` VO-01..06; `legal-content-mcp` 01..10 (07 included); `claims-vertical` 01..06 (issues already split from the PRD); `shadcn-migration` 01..04; `server-skeleton` WP-B-06; `native-resource-quota` 01..10.
- Decision and scope tickets complete (no code on `main` to dispatch): `legal-data-product-wayfinder` 01..12. Tickets 01..11 are `## Question` decision tickets. Ticket 12 is a scope ticket that says the collection program is not implemented.
- `legal-content-acquisition` 01..04 is the implementation split of wayfinder 12. Headers are `done`, but acceptance boxes remain unchecked or unaudited. See Parallel slices.
- Open, evidence or operations only (no new code tickets): see "Open items".
- Ticket text is historical. Several tickets disagree with themselves: a header `Status: done` with a body status line `ready-for-agent` (VER-01, VER-03, VO-01), a header `Label: ready-for-agent` (claims-vertical 01, 02, 05; `legal-content-acquisition` 02..04), or unchecked acceptance boxes (counts in Open items, item 5). Treat those as bookkeeping, not as new work. Reconcile them only in a separate change that is authorized to edit the tickets.
- `.scratch/` folders outside the clusters named in this file were not audited.
- `TODOS.md` (dated 2026-09-18) is stale. It lists VER/VO as the mainline, MCP 07 as `open`, and wayfinder 09..12 as `in_progress`/`open`. Do not use it for dispatch. Fixing it needs a separate change that is authorized to edit it.

## Phase 1: Virtual employee runtime (complete in code)

Reference: `.scratch/virtual-employee-runtime/PRD.md` (its header still says `ready-for-agent`; not reconciled here).

1. `VER-01` shared execution context seam: done. `server/ai/office/employee-runtime.ts`, `employee-runtime.test.ts`. Open: body status line still `ready-for-agent`; 5 acceptance boxes unchecked.
2. `VER-02` idempotent employee lifecycle and session registration: done. Implementation note dated 2026-09-30 in the ticket; `server/src/routes/employees.ts`, `server/src/db/employee-lifecycle.integration.test.ts`. Open: 7 acceptance boxes unchecked (ticket lines 12–18), including the retire credential rotation (line 17). The note describes that behavior, but the boxes have no recorded test evidence. Verify before ticking.
3. `VER-03` generic durable trigger runtime (takes over the daily claims-risk employee): done. `server/ai/office/employee-trigger-runtime.ts`, `employee-trigger-runtime.integration.test.ts`, `server/src/db/daily-claims-risk.integration.test.ts`. Open: body status line still `ready-for-agent`; 7 acceptance boxes unchecked.
4. `VER-04` durable execution windows and idempotent side effects: done. `employee-trigger-runtime.ver04.integration.test.ts`.
5. `VER-05` budget, loop, retry, and global backpressure: done. `employee-trigger-runtime.ver05.test.ts`, `employee-trigger-runtime.ver05.integration.test.ts`.
6. `VER-06` connection supervision, observability, capacity: done in code. Implementation record in the ticket; `employee-supervisor.ts`; `employee-trigger-runtime.ver06*.test.ts`; `GET /api/ops/employee-runtime/health`. The capacity figures come from a single-instance test over an in-memory fake session layer. They are not production capacity data.

Gate status:

- The Phase 1 gates in "Gates and red lines" are not verified as a whole here. Code-side evidence is the tests named in items 1–6 above.
- Production-side gates have no recorded run in the repo. The runbook `docs/runbooks/employee-runtime-observation.md` says a successful scripted run is not production acceptance (its "运行成功不等于生产验收" line). It also says VER-06 renewal, reconnect, capacity, and long-term operation are not accepted, and that QA still has to revalidate in production. The QA script is `scripts/verify-employee-runtime.ts`. No run record exists in the repo. Treat these as unverified until QA records a run.

## Phase 2: Virtual office (complete in code)

Reference: `.scratch/virtual-office/PRD.md` (header still says `ready-for-agent`; not reconciled here). The office ADR `docs/adr/virtual-office.md` is on `main`. Its section 9 covers the VO-06 onboarding, and section 5.1 covers browser-confirmed DDL.

1. `VO-01` office domain tables and generalized `user_notification` channel: done. `shared/sql/workspace-template/031-office-domain.surql`, `044-notification-generic-purpose.surql`, `server/src/db/office-domain.integration.test.ts`. Open: body status line still `ready-for-agent`; 7 acceptance boxes unchecked.
2. `VO-02` project-manager dispatch-to-report tracer: done. `server/ai/office/project-manager.ts`, `office-vertical.integration.test.ts`. Open: 8 acceptance boxes unchecked. No implementation note in the ticket.
3. `VO-03` human request once-only resolution loop: done. Note dated 2026-10-01 (resume fix for `waiting_on`/`requestId`); `041-office-request-resolution.surql`, `office-request.integration.test.ts`.
4. `VO-04` office live roster and activity page: done per header and body status, but all eight acceptance boxes are unchecked. Code: `web/src/screens/OfficeScreen.svelte`, `web/src/lib/office-runtime.ts` and its test. Acceptance evidence is not recorded in the ticket.
5. `VO-05` analyst-proposed, browser-admin-confirmed DDL: done. `045-office-analyst-ddl.surql`, `server/ai/office/analyst-ddl.integration.test.ts`, `web/src/components/OfficeDdlCard.svelte`.
6. `VO-06` idempotent onboarding from workspace creation to first report: done; all acceptance boxes checked. `POST /api/workspaces/:slug/office/bootstrap` (`server/src/routes/office.ts`), `web/src/lib/office-onboarding.ts` and its test, `046-office-onboarding.surql`. No production onboarding run is recorded.

Gate status:

- The Phase 2 gates in "Gates and red lines" are not verified as a whole here. Code-side evidence is the tests named in items 1–6 above.
- The production claims-risk reminder, inbox, and an end-to-end office run have no recorded production evidence in the repo.

## Parallel slices

- `claims-vertical`: issues 01..06 exist and their headers are `done`, so the earlier "needs `/to-issues` first" note is obsolete. The PRD header still says `ready-for-agent`. Open: acceptance boxes are unchecked on 01 (5), 05 (6), and 06 (6). Headers of 01, 02, and 05 still say `Label: ready-for-agent`.
  - 06 end-to-end acceptance: the ticket has a 2026-10-02 comment (`06-end-to-end-acceptance.md`, line 39). It says the closure re-test's only blocker, "含样例数据建簿 datetime 强转失败", was fixed by task `2ffbc97b` (`web/src/lib/workbooks.ts`, lines 452–455), and that the remaining acceptance criteria were completed by `CLAIMSE2E`. Neither `2ffbc97b` nor `CLAIMSE2E` appears anywhere in the repo. The six acceptance boxes are unchecked. The comment calls the production deployment re-test the final confirmation step, and no record of it exists. Status: the comment claims closure, the evidence cannot be traced, and production is unknown. Do not treat it as production acceptance.
- `SHADCN-04`: done, all boxes checked. Its prerequisites 01..03 are `done`, but their acceptance boxes are unchecked (6, 7, and 6 boxes).
- `WP-B-06`: done. Closeout note dated 2026-09-29 records a local podman build (158MB) and `/health` check. The CI `quality-gate` `docker build .` step keeps guarding it. No Docker-daemon re-run is recorded; this does not block anything.
- `legal-content-acquisition` (the implementation split of wayfinder 12): headers `done` for 01..04. Acceptance boxes: 01 has 4 unchecked, 02 has 4 checked, 03 has 5 unchecked, 04 has 5 checked. Headers of 02, 03, and 04 still say `Label: ready-for-agent`. Ticket 12 says its spec closure does not mean real sources are licensed or continuous collection has started. Do not treat the cluster as production-ready from its header.
- `legal-content-mcp` 01..04: headers `done`, but each has 3 acceptance boxes unchecked. This update did not verify whether the implementation covers them. Treat it as an evidence gap.

## Operations-only remainders

Not implementation work; do not open code tickets for them.

- Native quota production rollout: code tickets SCK-NQ-01..10 are done. The rollout steps (maintenance window, ledger backfill, cohort promotion, 24h/48h observation windows, product cutover, 30-day delayed cleanup) are described in `docs/runbooks/native-quota-release-cutover.md` and `docs/runbooks/native-quota-legacy-migration.md`. Do not run them from this file. Their status is to be confirmed:
  - `TODOS.md` (dated 2026-09-18) says "production execution not started". It is stale on other points, so treat it as unverified.
  - Unmerged PR #59 (`task/477e239e`, OPEN, not on `main`) records a boss decision dated 2026-09-29 to freeze the three-phase production closure. Production stays as it is, and the data-plane topology must not change. Phase 1 (exact-digest fork takes over the data directory and format migration) conflicts with that, and phases 2 and 3 depend on it. PR #59 is a to-confirm record. It is not a confirmed company decision on `main`.
  - Current production state: unknown from the repo. The owner must confirm whether the PR #59 freeze is in force before any rollout step.
- `legal-content-mcp` 07: done. `10-codex-e2e.md` records a production run on 2026-09-11 against `https://l.maplayer.top/api/ops/mcp` (DCR, PKCE, scope, refresh, reconnect, and refresh/access revocation; `--fixture --publish --full-lifecycle`, `ok=true`, 0 failures). This update did not re-run it. The same record says the production operator bootstrap config (OIDC subject and content capability) was not yet written at that time. Its current state is unknown. Confirm it before claiming operator-side readiness. `TODOS.md` still says "open"; that is stale.
- `legal-data-product-wayfinder` 01..12: decision and scope tickets only. Tickets 01..11 are `## Question` decision tickets. Ticket 12 says the collection program is not implemented, the scheduled task is not enabled, and it is not verified whether specific sites can be continuously fetched (ticket line 121). Its implementation split is `legal-content-acquisition` (see Parallel slices). Real-source licensing and continuous collection are unverified.

## Open items (evidence, not implementation)

1. VER-06 production QA revalidation (renewal, reconnect, capacity, long-term operation). Owner: QA with ops access. Per the runbook. No run is recorded.
2. VO-04 acceptance: all eight boxes unchecked. Needs evidence (tests or a browser run) before office roster acceptance is claimed.
3. VO-06 production onboarding: no production run recorded. Acceptance is unknown in production.
4. claims-vertical 01/05/06 acceptance boxes. The 06 end-to-end manual run has only an untraceable closure comment (see Parallel slices). Needs evidence. Production is unknown.
5. Ticket bookkeeping. Fix only in an authorized ticket-hygiene change. Counts are unchecked acceptance boxes in tickets whose header is `done`:

   | Ticket set | Unchecked boxes |
   | --- | --- |
   | VER-01 / 02 / 03 | 5 / 7 / 7 |
   | VO-01 / 02 / 04 | 7 / 8 / 8 |
   | claims-vertical 01 / 05 / 06 | 5 / 6 / 6 |
   | shadcn-migration 01 / 02 / 03 | 6 / 7 / 6 |
   | legal-content-acquisition 01 / 03 | 4 / 5 |
   | legal-content-mcp 01 / 02 / 03 / 04 | 3 / 3 / 3 / 3 |

   Body status line still `ready-for-agent`: VER-01, VER-03, VO-01. Header `Label: ready-for-agent`: claims-vertical 01, 02, 05; `legal-content-acquisition` 02..04. PRD headers still `ready-for-agent`: VER, VO, claims-vertical. The `legal-content-mcp` PRD header says `Status: open`.
6. Native quota production rollout status: to be confirmed. See Operations-only remainders, including the unmerged PR #59 record.
7. `legal-content-mcp` production operator bootstrap config (OIDC subject and content capability). Its state is unknown since the 2026-09-11 record.

Code completion is not production acceptance. Do not report a production result from a ticket's `done` header alone.

## How each next agent should work

Before editing:

1. Read `AGENTS.md`, `CONTEXT.md`, and the relevant PRD + issue file.
2. Read the ADRs named in that PRD.
3. Confirm the issue belongs to the current phase and its dependencies are merged.
4. If the issue writes Mastra code, load the `mastra` skill first.
5. If the issue writes schema or SurrealQL, load the `surrealql` skill first; if it is unavailable, verify against existing schema patterns.
6. Name the first observable behavior before editing production code.

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
