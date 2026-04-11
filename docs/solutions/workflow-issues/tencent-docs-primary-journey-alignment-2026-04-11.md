---
title: Tencent-compatible workbook UX should follow one primary journey
date: 2026-04-11
category: docs/solutions/workflow-issues
module: workbook_experience
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - refactoring a primary product surface from mock-first to real-data-first
  - splitting a document product into home and editor routes
  - aligning create, edit, publish, submit, and confirmation into one workflow
  - designing explicit auth, reconnect, permission, and missing-resource states
symptoms:
  - home and editor experiences diverge from the intended product workflow
  - quick-create produces placeholder behavior instead of usable records
  - public submission flow and confirmation feel disconnected from the workbook
  - failure states are implicit, confusing, or visually inconsistent
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags:
  - tencent-docs
  - workbook-home
  - editor-shell
  - mock-first
  - workflow-alignment
  - public-intake
  - system-states
---

# Tencent-compatible workbook UX should follow one primary journey

## Context

This refactor exposed a recurring failure mode in the repo: the primary user journey was split across competing entry points. Home behavior, editor behavior, template selection, mock data, and side-panel logic were all mixed into one shell, so the real workflow was hard to discover even though the underlying workbook, provisioning, and form capabilities already existed.

For this product, the dominant user habit is simple: open recent work, enter a sheet-first editor, publish a public intake form when needed, and continue review inside the same controlled workspace. Once that habit was used as the organizing rule, the route tree, shell structure, and state handling all became simpler and more trustworthy.

## Guidance

Design the product around one primary journey, then make route boundaries and UI hierarchy reflect that journey.

Use these rules:

- Split home and editor concerns at the router level instead of branching inside one catch-all shell.
- Remove mock-first and template-first behavior from the default path once real persisted objects exist.
- Keep the primary surface dominant. In a document product, the home route should feel like document home and the editor route should feel like entering a sheet, not a dashboard or admin panel.
- Treat auth failure, reconnecting, permission failure, deleted resources, and partial-loading states as first-class screens instead of fallthrough copy or blank shells.
- Ensure create, edit, publish, submit, and confirm all operate on the same underlying workflow object instead of disconnected demo paths.

Code-oriented pattern:

```tsx
// Prefer route-level separation of product modes.
<Route path="/workbooks" element={<WorkbookHome />} />
<Route path="/workbooks/:workbookId" element={<WorkbookEditor />} />
<Route path="/public/:workspaceId/forms/:formSlug" element={<IntakeForm />} />
```

```tsx
// Avoid defaulting users into mock/template flows.
if (workspaceError) return <WorkspaceErrorState />
if (!activeWorkbook) return <MissingWorkbookState />
return <SheetFirstEditor workbook={activeWorkbook} />
```

```tsx
// Keep the primary task central; docks support it.
<EditorLayout>
  <WorkbookSheet />
  <DockPanels>
    <ReviewPanel />
    <HistoryPanel />
    <PublishPanel />
  </DockPanels>
</EditorLayout>
```

In this repo, the concrete application of that pattern was:

- [src/app/router.tsx](/Users/y/IdeaProjects/surreal_ck/src/app/router.tsx): make `/workbooks` the home route, `/workbooks/$workbookId` the editor route, and public intake a dedicated route in the same narrative.
- [src/features/workbook/app-shell.tsx](/Users/y/IdeaProjects/surreal_ck/src/features/workbook/app-shell.tsx): separate home and editor rendering instead of mixing them behind one template-driven mode switch.
- [src/features/workbook/mock-data.ts](/Users/y/IdeaProjects/surreal_ck/src/features/workbook/mock-data.ts): reduce mock data to lightweight template metadata rather than a behavioral source of truth.
- [src/features/workbook/use-workspace.ts](/Users/y/IdeaProjects/surreal_ck/src/features/workbook/use-workspace.ts): let real workspace/workbook data drive ordering and list surfaces.
- [src/forms/intake-form.tsx](/Users/y/IdeaProjects/surreal_ck/src/forms/intake-form.tsx) and [src/forms/confirmation.tsx](/Users/y/IdeaProjects/surreal_ck/src/forms/confirmation.tsx): align public intake language with the same controlled legal workflow as the workbook.

## Why This Matters

When the main journey is ambiguous in code, it becomes ambiguous in product. Users feel that ambiguity immediately: they see templates before documents, panels before content, and placeholder affordances before real work. The system feels like a demo, even when the backend and data model are real.

A single explicit journey improves both UX and implementation quality:

- routing becomes easier to reason about
- state handling becomes honest instead of implicit
- quick create and publish-to-form compose cleanly with the editor
- future seams such as review/history/AI can be visible without displacing the sheet

This learning also pairs well with the existing backend constraint that the architectural spine should remain intact while boundaries get clearer. The relevant invariant is already documented in [docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md](/Users/y/IdeaProjects/surreal_ck/docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md): preserve the real schema/collaboration model, but do not let the surface drift away from the true workflow.

## When to Apply

- A screen is serving two different jobs, such as home and editor.
- Mock data or starter templates still drive the default UX after real persistence exists.
- Secondary controls are visually or structurally competing with the main task surface.
- Users must infer important failure states from generic loading behavior or empty panels.
- A multi-step workflow exists, but its steps are implemented as separate features instead of one continuous object lifecycle.

This is especially important in document, spreadsheet, form, and collaboration products where users expect “open recent work, edit it, share it, collect responses” to feel like one system.

## Examples

Before:

- One `AppShell` mixed homepage, template gallery, editor chrome, and panel logic.
- `/templates` and mock data acted like the real product path.
- Users encountered side panels and provisioning affordances before they understood the workbook itself.
- Missing workbook, reconnect, and permission failures were implicit or buried in generic loading states.

After:

- `/workbooks` reads as a Tencent-compatible recent-documents home.
- `/workbooks/$workbookId` reads as a sheet-first editor with subordinate right dock.
- quick create provisions a real workbook instead of routing the user into placeholder logic.
- public intake and confirmation copy are part of the same legal workflow as workbook publishing.
- reconnect/auth/permission/missing-resource states are explicit and visually stable.

Concrete anti-pattern vs preferred pattern:

```tsx
// Anti-pattern: one shell decides everything.
<AppShell mode={hasWorkbook ? 'editor' : 'templates'} />
```

```tsx
// Preferred: route decides the journey, screen decides the task.
if (route === '/workbooks') return <RecentDocumentsHome />
if (route === '/workbooks/:id') return <WorkbookEditor />
```

```tsx
// Anti-pattern: mock content stands in for product truth.
const workbook = realWorkbook ?? demoWorkbook
```

```tsx
// Preferred: explicit state surface.
if (!realWorkbook) return <MissingWorkbookState />
```

## Related

- [DESIGN.md](/Users/y/IdeaProjects/surreal_ck/DESIGN.md)
- [docs/plans/2026-04-10-001-feat-tencent-compat-bankruptcy-claims-plan.md](/Users/y/IdeaProjects/surreal_ck/docs/plans/2026-04-10-001-feat-tencent-compat-bankruptcy-claims-plan.md)
- [docs/brainstorms/2026-04-10-bankruptcy-claims-workflow-artifact.md](/Users/y/IdeaProjects/surreal_ck/docs/brainstorms/2026-04-10-bankruptcy-claims-workflow-artifact.md)
- [docs/plans/attachments/2026-04-10-tencent-compat-parity-matrix.md](/Users/y/IdeaProjects/surreal_ck/docs/plans/attachments/2026-04-10-tencent-compat-parity-matrix.md)
- [docs/plans/2026-04-05-001-feat-graph-spreadsheet-mvp-plan.md](/Users/y/IdeaProjects/surreal_ck/docs/plans/2026-04-05-001-feat-graph-spreadsheet-mvp-plan.md)
- [docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md](/Users/y/IdeaProjects/surreal_ck/docs/solutions/best-practices/surrealdb-sheet-as-table-schema-design-2026-04-06.md)
