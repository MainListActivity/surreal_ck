# AGENTS.md

## Engineering Guardrails

- Package manager is `pnpm` only. Use `pnpm add`, `pnpm remove`, `pnpm install`, and `pnpm run`.
- Do not introduce or regenerate `package-lock.json` or `yarn.lock`.
- Keep the repository lockfile as `pnpm-lock.yaml` and keep `packageManager` in `package.json` aligned with the installed pnpm major version.
- SurrealDB runtime access is worker-only. UI code must not import `surrealdb` directly.
- All database connect/auth/query/mutation flows go through the shared Web Worker boundary under `src/surreal`.
- Architecture is offline-first: app shell uses a service worker cache; Surreal session/cache state persists locally; optimistic mutations queue locally before network replay; network recovery must reconcile from cached state instead of blocking the UI.
- Treat edge caching as a first-class deployment concern for static assets and workbook bootstrap payloads. Avoid designs that require every first render to hit origin.

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

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
