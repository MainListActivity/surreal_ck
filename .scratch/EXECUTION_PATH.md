# .scratch issue execution path

Updated: 2026-09-18

This file is the canonical scheduling order for the next agents. The web-only pivot spine (clusters A/B/C/D1/D2, dashboard migration D3), the operating iteration plan, resource retrieval, the native quota control plane, and the platform legal content MCP have all landed. What remains is the virtual employee runtime, the virtual office on top of it, and a few parallel slices.

## Non-negotiable constraints

- Do not revive Electrobun, sidecar windows, external WebView research windows, renderer/main RPC, service JWT, NS-admin, backend business CRUD proxies, or SurrealDB LIVE forwarding.
- Use `pnpm` only.
- Code lives in `server/`, `web/`, `shared/`, `ops/`, `marketing/`; there are no legacy folders left.
- Business data reads/writes default to browser direct SurrealDB. Allowed backend exceptions are the Workspace Scope Module, Mastra `/api/chat*`, resource save confirmation SSE, the employee/office runtime, the ops MCP and content endpoints, and root maintenance paths.
- Mastra implementation work must load the `mastra` skill first.
- SurrealQL implementation work must load the `surrealql` skill first and follow the project SurrealDB rules. If the skill is unavailable, say so and verify against existing ADR/schema patterns before writing schema.
- Implementation work follows the `tdd` skill: one public-interface behavior test, then the minimum implementation, then the next behavior. Do not write broad horizontal test suites ahead of implementation.

## Current inventory

- `ready-for-agent`: `virtual-employee-runtime` PRD + VER-01..06, `virtual-office` PRD + VO-01..06, `claims-vertical` PRD (needs `/to-issues` first), `SHADCN-04`.
- `ready-for-human`: `WP-B-06` (Dockerfile / `.env.example` / startup docs sign-off).
- `open`, blocked on operations, not code: `legal-content-mcp` `07-mcp-oauth` (real Codex DCR/PKCE/refresh against the production `ck` tenant).
- `in_progress` / `open` decision tickets, not implementation: `legal-data-product-wayfinder` 09 / 10 / 11 / 12.
- Everything else under `.scratch/` is `done` or `wontfix`; historical issue text may describe pre-pivot execution paths — use it for semantics only.

## Phase 1: Virtual employee runtime

Reference: `.scratch/virtual-employee-runtime/PRD.md`. Run mostly sequentially; this is the runtime substrate the office depends on.

1. `VER-01` shared execution context seam (Router behavior, permissions, and streaming must not change)
2. `VER-02` idempotent employee lifecycle and session registration
3. `VER-03` generic durable trigger runtime takes over the daily claims-risk employee
4. `VER-04` durable execution windows and idempotent side effects
5. `VER-05` budget, loop, retry, and global backpressure
6. `VER-06` connection supervision, observability, capacity

Gate:

- Router workflow output, tool permissions, and stream events are unchanged after `VER-01`.
- Employee sessions are opened/closed by lifecycle transitions; root is only used for the workspace index and employee credentials.
- The existing daily claims-risk reminder still reaches users, now through the generic trigger runtime.
- A crashed process re-establishes active / waiting / suspended runs without duplicating business side effects.
- Limits emit a structured runtime signal instead of silently widening.

Parallelism:

- `VER-02` and `VER-03` can overlap after `VER-01` if write scopes stay separate (lifecycle store vs trigger adapter).
- `VER-04`..`VER-06` are hardening slices on top and should not be started before the trigger runtime exists.

## Phase 2: Virtual office

Reference: `.scratch/virtual-office/PRD.md`. Requires Phase 1.

1. `VO-01` office domain tables in the workspace template + generalized `user_notification` channel
2. `VO-02` project-manager dispatch-to-report tracer
3. `VO-03` human request once-only resolution loop
4. `VO-04` office live roster and activity page (`OfficeDataRuntime`)
5. `VO-05` analyst-proposed, browser-admin-confirmed DDL
6. `VO-06` idempotent onboarding from workspace creation to first report

Gate:

- The shipped daily claims-risk reminder and inbox keep working while `user_notification` generalizes.
- Employees write office records with employee `$auth` and DML only; any DDL is executed by the issuing human's browser admin session.
- Office UI reads through browser direct SurrealDB LIVE, never backend LIVE forwarding.
- Budget/loop guards from `VER-05` prevent infinite task loops in a deterministic test.

## Parallel slices

These do not depend on Phases 1-2 and can be picked up by a separate agent:

- `claims-vertical`: split the PRD into issues first. All legal vocabulary stays in `workbook_template` rows; platform code, schema, and prompts stay domain-free.
- `SHADCN-04`: visual alignment cleanup, small.
- `WP-B-06`: human sign-off on Dockerfile / `.env.example` / startup docs.

## Operations-only remainders

Not implementation work; do not open code tickets for them:

- Native quota production rollout: maintenance window, ledger backfill, cohort promotion, 24h/48h observation windows, product cutover, and the 30-day delayed cleanup, per `docs/runbooks/native-quota-release-cutover.md` and `docs/runbooks/native-quota-legacy-migration.md`.
- `legal-content-mcp` `07`: real DCR/PKCE/refresh test with the production IdP, blocked on the `ck` tenant login configuration.

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
