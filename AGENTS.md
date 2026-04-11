# AGENTS.md

Always output zh_CN.

## Engineering Guardrails

- Package manager is `pnpm` only. Use `pnpm add`, `pnpm remove`, `pnpm install`, and `pnpm run`.
- Do not introduce or regenerate `package-lock.json` or `yarn.lock`.
- Keep the repository lockfile as `pnpm-lock.yaml` and keep `packageManager` in `package.json` aligned with the installed pnpm major version.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## React Rules
Any time you write React Code — you MUST invoke the `vercel-react-best-practices` skill FIRST and follow its rules.

## SurrealDB Rules

Any time you write SurrealQL — schema, queries, or permissions — you MUST invoke the `surrealdb` skill FIRST and follow its rules.

Past schema decisions are documented in `docs/solutions/` (organized by category, searchable by `module`, `tags`, `problem_type`). Relevant when designing schema or debugging data model issues.

Key rules to internalize:

只有当关系本身是业务实体（有属性、有生命周期、有双向遍历需求）时才用边；否则用字段。
系统结构关系（层级归属、所有权）用字段，用户业务关系（公司持股、案件关联）用边。

- 数据库的id类型在传递给数据库时，必须用RecordId类型或new StringRecordId(id)包裹。

### Permissions belong in the schema, never in queries

Row-level security is defined once in `DEFINE TABLE ... PERMISSIONS` and enforced by the database engine. Frontend queries must NOT contain auth-filtering conditions (`WHERE user = $auth`, `WHERE in = $auth`, etc.). A query that leaks permission logic into the client is a security defect: the engine enforces PERMISSIONS regardless, so the client filter is at best redundant and at worst misleading.

Frontend queries only carry **user-driven filter options** (e.g. status, date range, search term) that the user controls from the UI.

### Use graph traversal syntax in PERMISSIONS and queries

SurrealDB's `->` / `<-` operators replace verbose `SELECT VALUE ... FROM edge WHERE in = x` patterns. Always prefer graph traversal:

```surql
-- ✗ verbose, non-idiomatic
$auth IN (SELECT VALUE in FROM owns_workspace WHERE out = id)

-- ✓ graph traversal, idiomatic
id IN $auth->owns_workspace->workspace
```

Standard access patterns used in this project:
- Owner check: `id IN $auth->owns_workspace->workspace`
- Member check: `id IN $auth<-member_identifies_user<-workspace_member<-workspace_has_member<-workspace`
- Workbook visibility: `id IN $auth->owns_workspace->workspace->workspace_has_workbook->workbook`

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
