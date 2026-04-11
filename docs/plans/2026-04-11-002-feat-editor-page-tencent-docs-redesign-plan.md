---
title: "feat: Editor page — Tencent Docs-compatible chrome redesign"
type: feat
status: completed
date: 2026-04-11
---

# feat: Editor page — Tencent Docs-compatible chrome redesign

## Overview

Redesign the spreadsheet editor page (`view === 'editor'`) so it matches the Tencent Docs editor aesthetic shown in the reference image. The current `EditorChrome` component renders a custom header + subheader with dock tabs that looks nothing like the target. The Univer canvas already renders its own menu bar, toolbar, sheet tabs, and status bar. The task is to:

1. Replace the custom `editor-shell__header` + `editor-shell__subheader` with a minimal Tencent-compatible top bar (logo, doc title + autosave indicator, right actions: notification/help/share/avatar).
2. Remove the `editor-shell__subheader` and its dock tab row — these controls are not present in the target UI as a separate bar.
3. Let the Univer canvas occupy the full height below the top bar with zero competing chrome.
4. Preserve the right-dock (`workbook-drawer`) as a progressive-reveal overlay behind an action button (not a persistent subheader tab row).
5. Surface the connection state inline in the top bar (autosave chip) rather than via the `ConnectionBanner`.

## Problem Frame

Users familiar with Tencent Docs expect the spreadsheet editor to look exactly like the reference image: a single thin top bar housing the file title + cloud-save status, then Univer's native menu bar, toolbar, and sheet canvas with no competing header structure. The current `EditorChrome` wraps the canvas in a two-row custom header + subheader that feels like a different product, creating visual discontinuity ("This is not Tencent Docs").

Design.md rule: "The first 3 seconds should feel like entering a familiar spreadsheet." The current double-header violates this.

## Requirements Trace

- R1. Top bar: single row, white background, left section = logo mark + editable doc title + autosave chip; right section = notification icon + help icon + share button + avatar.
- R2. The autosave chip communicates the connection state (已自动保存到云端 / 重连中… / 连接中断) — replaces both the current `ConnectionBanner` and `editor-shell__subheader` status copy.
- R3. Univer canvas fills the remaining vertical space with no extra whitespace above it (menu bar + toolbar + grid + sheet tabs are all Univer's own).
- R4. Right dock (`workbook-drawer`) is preserved but triggered from the "更多工具" or panel action button in the top bar right section, not from a persistent dock-tab subheader row.
- R5. The `editor-shell__subheader` row and its dock tabs are removed from the visible page structure.
- R6. The `ConnectionBanner` (reconnecting / disconnected full-width strip) is absorbed into the autosave chip state. The banner itself is removed.
- R7. `univer-header` extensions (`HeaderLeft`, `HeaderRight`) registered into Univer's `custom-left` / `custom-right` slots are removed or emptied — the full top bar is now owned by the React shell, not Univer's header slot.
- R8. Mobile/tablet: top bar stacks or narrows gracefully; dock becomes a slide-over. No regressions for existing responsive styles.

## Scope Boundaries

- No changes to the home page shell (`tdocs-*` components).
- No changes to the folder / my-docs feature.
- No new routing — editor is still reached via `view === 'editor'` on the same route.
- No Univer plugin changes beyond removing/emptying the `mountUniverHeaderExtensions` call.
- The right dock panels (`GraphResultsPanel`, `RecentChangesPanel`, admin tools, etc.) are unchanged — only how they are triggered changes.
- Template gallery is unchanged.
- No dark-mode work.

## Context & Research

### Relevant Code and Patterns

- `src/features/workbook/app-shell.tsx` `EditorChrome` component (line 460–621) — the component to redesign. Contains `editor-shell`, `editor-shell__header`, `editor-shell__subheader`, dock tabs, `editor-shell__body`, `editor-shell__canvas`, and `workbook-drawer`.
- `src/workbook/univer-header.tsx` — `mountUniverHeaderExtensions` registers `HeaderLeft` (switcher + editable title) and `HeaderRight` (share + avatar) into Univer's slots. These must be emptied or removed since the title/avatar now live in the React shell top bar.
- `src/styles/global.css` — `editor-shell*` CSS classes (lines ~1581–1619). New `ck-editor-topbar*` classes must be added here following the `tdocs-*` naming and spacing conventions.
- `src/features/workbook/app-shell.tsx` `ConnectionBanner` component (line 624–635) — used in both home and editor. For the editor, its reconnect state is absorbed into the autosave chip. For the home page it stays unchanged.
- `src/features/workbook/app-shell.tsx` `UniverGrid` component (line 744+) — renders the `univer-container` div and calls `bootstrapUniver`; `mountUniverHeaderExtensions` is called inside `bootstrapUniver`. The prop list and call site stay the same; only the header slot contents become no-ops.
- `src/workbook/univer.ts` — calls `mountUniverHeaderExtensions`. Strategy: pass empty/no-op opts, or export a new `unmountUniverHeader` path.

### Institutional Learnings

- DESIGN.md: editor page hierarchy — first: sheet canvas; second: toolbar and sheet tabs; third: docked workflow tools. The current double-header inverts this.
- DESIGN.md: "If a UI choice makes the product feel like a new tool, it is probably wrong."
- `tdocs-*` CSS namespace is established for the home shell. Use `ck-editor-topbar` prefix for the new editor top bar to keep namespaces separate and not pollute the home styles.
- `workbook-drawer` CSS already positions as `position: absolute; right: 0; top: 0` — it is already overlay-ready. No layout changes needed to the drawer itself.

### External References

- Reference image: Tencent Docs editor (2026-04-11) — top bar anatomy: [logo] [hamburger] [doc title] [autosave chip] [spacer] [AI quota notice] [≡] [🔔] [👤] [Share button] [avatar].
- Univer `registerUIPart` with `'custom-left'` and `'custom-right'` — if we stop registering these, Univer renders its default empty slots, which is acceptable. Alternatively, pass completely empty components.

## Key Technical Decisions

- **Full ownership of top bar by React shell**: The new `ck-editor-topbar` bar is a plain React `<header>` rendered by `EditorChrome`, above the `editor-shell__body`. Univer's `custom-left` / `custom-right` slots receive no-op empty components (or stop being registered). This keeps the workbook-switcher dropdown logic in `EditorChrome` directly.
- **Autosave chip absorbs connection state**: A single `<span className="ck-editor-autosave">` reads from `connection.state` and shows one of three copy strings. No separate `ConnectionBanner` inside the editor path. The `ConnectionBanner` component remains for the home page only.
- **Dock trigger moves to top bar**: A `...` or panel icon button in the top bar right section toggles `activePanel`. The `editor-shell__subheader` dock-tab row is removed. Panel state still lives in `AppShell` / `EditorChrome` props (`activePanel`, `onSelectPanel`).
- **Layout**: `editor-shell` grid becomes `grid-template-rows: auto minmax(0, 1fr)` (was `auto auto 1fr` for header + subheader + body). The single `auto` row is the new top bar.
- **CSS namespace**: new classes are prefixed `ck-editor-topbar` to match existing `ck-header-*` conventions (not `tdocs-*` which is home-only). Old `editor-shell__header` and `editor-shell__subheader` classes are removed from the CSS.

## Open Questions

### Resolved During Planning

- **Keep or remove dock tabs**: Remove the subheader dock tab row from the visible bar. The dock still opens, triggered by a button in the top-bar right section. Rationale: Tencent Docs reference image has no second header row.
- **Univer header slot strategy**: Register empty/no-op components for `custom-left` and `custom-right`. This avoids removing the `mountUniverHeaderExtensions` call entirely (which would require tracing all callers in `univer.ts`) and cleanly empties the slot. Implementing agent may choose to conditionally skip registration instead.
- **`ConnectionBanner` for editor**: removed from the editor path. Home page retains it unchanged. The autosave chip provides the same signal inside the editor.

### Deferred to Implementation

- Exact copy strings for the autosave chip in each connection state (agent should align with existing `formatConnectionLabel` logic already used in the home shell).
- Whether the workbook-switcher dropdown (currently in `HeaderLeft`) stays in the top bar as a `▾` button next to the doc title, or is moved to a separate affordance. Implement whichever feels more like Tencent Docs from the reference image.
- Whether to add a "返回首页" breadcrumb before the doc title (Tencent Docs shows a `≡` hamburger that reveals the workbook list). Implementing agent decides based on the reference.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Layout before vs after

```
BEFORE (current EditorChrome):
┌─ editor-shell (grid: auto auto 1fr) ──────────────────┐
│ editor-shell__header  [Back] [Title] | [chips] [btns]  │
│ editor-shell__subheader  [meta] | [dock tabs]          │
│ editor-shell__body                                      │
│  └─ editor-shell__canvas (Univer)                      │
│  └─ workbook-drawer (absolute overlay)                  │
└────────────────────────────────────────────────────────┘

AFTER (redesigned EditorChrome):
┌─ editor-shell (grid: auto 1fr) ───────────────────────┐
│ ck-editor-topbar                                        │
│  [logo] [≡] [doc-title] [autosave-chip]  [🔔][?][⋯][Share][avatar] │
│ editor-shell__body                                      │
│  └─ editor-shell__canvas (Univer)                      │
│     └─ Univer menu bar (native)                        │
│     └─ Univer toolbar (native)                         │
│     └─ Univer grid (native)                            │
│     └─ Univer sheet tabs (native)                      │
│  └─ workbook-drawer (absolute overlay, on demand)       │
└────────────────────────────────────────────────────────┘
```

### Top bar anatomy

```
[logo 20px] [≡ switcher] [doc-title editable] [autosave chip]
                                   ——spacer——
[notification] [help] [panel toggle] [Share] [avatar]
```

## Implementation Units

- [ ] **Unit 1: Replace `EditorChrome` header structure**

**Goal:** Remove `editor-shell__header` and `editor-shell__subheader` from `EditorChrome`. Replace with a single `ck-editor-topbar` bar. Update `editor-shell` grid to `auto 1fr`. Keep the `editor-shell__body` and `workbook-drawer` unchanged.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/features/workbook/app-shell.tsx`

**Approach:**
- Delete the `<header className="editor-shell__header">` block entirely.
- Delete the `<div className="editor-shell__subheader">` block entirely.
- Insert a new `<header className="ck-editor-topbar">` as the first child of `editor-shell__body`'s parent (i.e., first child of `<div className="editor-shell">`).
- Top bar left section (`ck-editor-topbar__left`): logo SVG (same 20×20 grid mark as home), workbook-switcher button (hamburger → opens dropdown listing all workbooks), editable doc-title (click to edit, Enter/Blur saves — mirror existing `HeaderLeft` logic but in React JSX not `createElement`), autosave chip.
- Top bar right section (`ck-editor-topbar__right`): panel toggle button (opens/closes `workbook-drawer`), share button, avatar button (with logout on click).
- Autosave chip: reads `connection.state` and renders one of: `已自动保存到云端` (connected), `重连中…` (reconnecting), `连接中断` (disconnected). Use `data-state={connection.state}` for CSS color targeting.
- Remove the `ConnectionBanner` from the editor path (in `AppShell`, `ConnectionBanner` is rendered only when `view === 'home'`, or conditionally skip it in editor).
- The dock-tab buttons (record / graph / history / review / ai / admin) are moved into the top bar right section as a compact icon group, or removed and replaced by a single "工具面板" toggle button. Implementing agent chooses based on the reference image (the reference shows no second header row — a single toggle icon is preferred).

**Patterns to follow:**
- `tdocs-topbar` pattern in `app-shell.tsx` for left/right layout and spacing.
- Existing `ck-header-title` / `ck-header-title-input` pattern in `global.css` for editable title.
- `workbook-drawer` trigger: existing `onSelectPanel` callback already toggles panel.

**Test scenarios:**
- Happy path render: editor view renders `ck-editor-topbar` with doc title visible; no `editor-shell__header` element in DOM.
- Title edit: clicking doc title renders `<input>` pre-filled with workbook name; Enter blurs and reverts to `<button>`; Escape cancels.
- Autosave chip — connected: `connection.state === 'connected'` → chip shows "已自动保存到云端".
- Autosave chip — reconnecting: `connection.state === 'reconnecting'` → chip shows "重连中…".
- Panel toggle: clicking panel toggle button calls `onSelectPanel`; drawer opens.
- Share button: clicking share button copies URL to clipboard (existing behavior).
- Workbook switcher: clicking `≡` button opens dropdown list of workbooks; clicking a workbook calls `onSelectWorkbook`.
- Home link: clicking "返回" or logo calls `onShowHome`.
- `editor-shell__header` and `editor-shell__subheader` elements are NOT present in the rendered DOM.

**Verification:** `editor-shell__header` and `editor-shell__subheader` no longer appear in the DOM; top bar renders doc title and autosave chip; all editor actions (open panel, switch workbook, logout) remain functional.

---

- [ ] **Unit 2: Add `ck-editor-topbar` CSS**

**Goal:** Add CSS for the new top bar, clean up now-unused `editor-shell__header` and `editor-shell__subheader` classes, and update the `editor-shell` grid.

**Requirements:** R1, R3, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `src/styles/global.css`

**Approach:**
- Change `.editor-shell` grid to `grid-template-rows: auto minmax(0, 1fr)`.
- Remove (or comment out) `.editor-shell__header`, `.editor-shell__subheader`, `.editor-shell__title`, `.editor-shell__meta`, `.editor-shell__dock-tabs`, `.editor-shell__actions` rule blocks. (These classes are no longer rendered in Unit 1.)
- Add `.ck-editor-topbar`: `display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; background: var(--color-paper); border-bottom: 1px solid var(--color-line); flex-shrink: 0`.
- Add `.ck-editor-topbar__left` and `.ck-editor-topbar__right`: flex row, `align-items: center`, `gap: 8px`. Right section gets `margin-left: auto`.
- Add `.ck-editor-autosave`: small muted chip, font-size `0.76rem`, color `var(--color-muted)`. `data-state="reconnecting"` → `color: var(--color-warning)`. `data-state="disconnected"` → `color: var(--color-error)`.
- Add `.ck-editor-topbar__title` (same shape as `.ck-header-title` — inherit the existing styles or re-declare compactly).
- Responsive: at narrow widths, hide autosave chip text and show icon-only share button.

**Patterns to follow:**
- `.ck-header-btn`, `.ck-header-avatar`, `.ck-header-title` — reuse or extend rather than copy.
- `.tdocs-connection-chip[data-state]` — same data-attribute pattern for state-driven color.
- 8px base unit, 44px height aligns with minimum touch target requirement.

**Test scenarios:**
- Test expectation: none — CSS-only change. Visual correctness verified by QA pass after Unit 1 lands.

**Verification:** Top bar is 44px tall, white background, doc title is visible and editable, autosave chip changes color based on `data-state`. Univer canvas fills the full remaining height with no gap.

---

- [ ] **Unit 3: Empty Univer header slot extensions**

**Goal:** Stop registering custom content in Univer's `custom-left` and `custom-right` header slots, since the workbook title and avatar are now owned by the React shell top bar.

**Requirements:** R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/workbook/univer-header.tsx`
- Modify: `src/workbook/univer.ts` (if `mountUniverHeaderExtensions` is called there)

**Approach:**
- In `univer-header.tsx`, change `mountUniverHeaderExtensions` to register empty (null-returning) components for both slots, OR guard the registration so it is skipped when opts signals no content is needed. The simplest approach: export a `clearUniverHeaderExtensions` function that registers `() => null` for both slots, and call it from the bootstrap path. Alternatively, remove the `registerUIPart` calls entirely if Univer handles missing slots gracefully.
- Verify in `univer.ts` / `bootstrapUniver` that the call site is updated to match.
- Preserve the exported `UniverHeaderOptions` type and `mountUniverHeaderExtensions` function signature to avoid breaking other callers, but its body becomes a no-op or an empty-slot registration.

**Patterns to follow:**
- Existing `mountUniverHeaderExtensions` call in `univer.ts`.
- `univerAPI.registerUIPart` accepts `() => null` — this is valid and renders nothing.

**Test scenarios:**
- Test expectation: none — Univer bootstraps without TypeScript errors; custom-left and custom-right slots render empty. Verified visually by QA.

**Verification:** No TypeScript errors; Univer header bar does not render the old `HeaderLeft` or `HeaderRight` content; no duplicate title or avatar appears inside the Univer chrome.

---

- [ ] **Unit 4: `EditorChrome` — remove `ConnectionBanner` from editor path**

**Goal:** The `ConnectionBanner` full-width strip is no longer shown in the editor view (autosave chip handles the state). Ensure it still shows on the home page.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/features/workbook/app-shell.tsx`

**Approach:**
- In `AppShell`, `ConnectionBanner` is currently rendered unconditionally before the view branch. Move it inside the `view === 'home'` branch only (or add a `view !== 'editor'` guard).
- The `EditorChrome` component itself does not receive `ConnectionBanner`; it receives `isOffline` prop and uses the `editor-shell__hint` paragraph. That hint paragraph can remain as a fallback below the canvas (non-blocking, low-chrome) or be removed in favour of the chip alone — implementing agent decides.

**Patterns to follow:**
- Existing `ConnectionBanner` usage in `app-shell.tsx`.

**Test scenarios:**
- Home view + reconnecting: `ConnectionBanner` still renders.
- Editor view + reconnecting: `ConnectionBanner` does NOT render; autosave chip shows warning state.

**Verification:** No `reconnect-banner` element in DOM when in editor view; home page reconnect banner unaffected.

---

- [ ] **Unit 5: QA and visual polish pass**

**Goal:** Verify the redesigned editor page matches the Tencent Docs reference image across standard breakpoints and connection states. Fix any spacing or layout regressions.

**Requirements:** R1–R8

**Dependencies:** Units 1–4

**Files:**
- Modify: `src/styles/global.css` (minor fixes only)
- Modify: `src/features/workbook/app-shell.tsx` (minor fixes only)

**Approach:**
- Use `/qa` skill to test the editor page: check top bar height, title editability, autosave chip states, panel toggle, workbook switcher dropdown, share button, avatar/logout.
- Verify Univer canvas fills the viewport below the top bar with no visible gap.
- Verify right dock overlay does not shift the canvas (it is `position: absolute` already).
- Fix any spacing, overflow, or z-index issues found.

**Test scenarios:**
- Test expectation: none for this unit — validated by QA tool output and visual comparison to reference image.

**Verification:** QA pass reports no visual regressions; editor top bar matches the Tencent Docs reference image.

## System-Wide Impact

- **Interaction graph:** `ConnectionBanner` rendering condition changes — home-only now. No other components affected.
- **Error propagation:** Panel open/close still routes through `onSelectPanel` callback in `AppShell`. No change to panel content components.
- **State lifecycle risks:** Editable doc-title inline edit state is now in `EditorChrome` directly (was in Univer's `HeaderLeft`). Risk: title state desync if workbook changes while editing. Mitigation: same `if (!isEditing && title !== workbookName) setTitle(workbookName)` guard already used in `HeaderLeft`.
- **API surface parity:** `AppShellProps` is unchanged. `UniverHeaderOptions` type is preserved (even if the function body becomes a no-op).
- **Unchanged invariants:** Home page shell (`tdocs-*`) is entirely unaffected. The right dock panels, sheet hooks, and collaboration layer are unchanged. Routing is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Univer renders its own top bar header with empty slots — may leave an unwanted blank bar | Verify Univer hides the header bar when no content is registered; if not, use CSS `display: none` on the Univer header element (it has a stable class). |
| Doc title state duplication (was in `HeaderLeft`, now in `EditorChrome`) | Use the same guard pattern; initialize from `activeWorkbook.name` prop; handle prop change. |
| Old `editor-shell__header` CSS removal breaks other selectors that extend it | Grep for all usages before deleting; the only extenders are in `global.css` and the tablet media query. |
| `workbook-drawer` absolute positioning may clip under the new top bar | Top bar is in flow, drawer uses `top: 0` relative to `editor-shell__body` which starts below the top bar — no change needed. Verify in QA. |

## Sources & References

- Reference image: Tencent Docs editor screenshot, provided 2026-04-11
- `src/features/workbook/app-shell.tsx` — `EditorChrome`, `ConnectionBanner`, `UniverGrid`
- `src/workbook/univer-header.tsx` — `mountUniverHeaderExtensions`
- `src/styles/global.css` — `editor-shell*` classes (lines ~1581–1619)
- DESIGN.md — Editor Page Rules, Typography, Color
