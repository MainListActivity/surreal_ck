# Design System — surreal_ck

## Product Context
- **What this is:** A Tencent Docs-compatible legal collaboration product for sensitive bankruptcy creditor workflows.
- **Who it's for:** Bankruptcy administrator legal teams, legal operators, and assistants who already live inside Tencent Docs and Excel.
- **Space/industry:** Legal tech, creditor operations, sensitive collaborative data work.
- **Project type:** Authenticated web app with a document-home page and a spreadsheet editor page.

## Core Design Thesis
- **Primary goal:** Reduce switching cost to near zero.
- **Product promise:** Feels immediately familiar to Tencent Docs users, but more trustworthy for sensitive legal work.
- **Design strategy:** Clone the outer habit, then layer in legal-grade trust.
- **Wrong direction:** Generic legal dashboard, no-code admin panel, or Airtable/Grist-style productized workspace.
- **Right direction:** Tencent-native familiarity with quieter hierarchy, stronger control signals, and less consumer casualness.

## Aesthetic Direction
- **Direction:** Familiar, calm, document-native, legally trustworthy.
- **Decoration level:** Very low. This is not a brand showcase and not a productivity toy.
- **Mood:** Familiar first, serious second, controlled third.
- **Reference feel:** Tencent Docs mental model, but with less consumer brightness and more professional restraint.
- **What the user should feel in 5 seconds:** "I know how to use this."
- **What the user should feel in 30 seconds:** "This version is safer and more deliberate."

## Product Posture
- Home page is list-first, not dashboard-first.
- Editor page is sheet-first, not panel-first.
- Familiarity beats novelty on the primary path.
- Specialized legal features appear progressively, not all at once.
- Trust comes from stability, density, restrained typography, and clear system state.
- If a UI choice makes the product feel like a new tool, it is probably wrong.

## Typography
- **Display / emphasis:** `IBM Plex Serif` — used sparingly for trust-heavy headings, confirmations, and key workspace labels.
- **Primary UI / body:** `IBM Plex Sans` + `Noto Sans SC`
- **Data / structured values:** `IBM Plex Mono`
- **Loading:**
  - `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;700&display=swap`
- **Usage rules:**
  - Use sans for almost all UI
  - Use serif only to add authority in sparse moments, never for the whole shell
  - Use mono only where precision matters
- **Scale:**
  - app title: `1.5rem - 1.875rem`
  - section title: `1.125rem`
  - body: `0.96rem - 1rem`
  - small/meta: `0.76rem - 0.82rem`

## Color
- **Approach:** Tencent-compatible lightness with legal-grade restraint.
- **Primary ink:** `#1F2A37`
- **Primary action:** `#2F6BFF`
- **Primary action hover:** `#2458D6`
- **Trust accent:** `#1F5C4C`
- **Alert / legal caution:** `#A35A1E`
- **Danger:** `#A63C35`
- **Surface palette:**
  - canvas: `#F7F8FA`
  - panel: `#FFFFFF`
  - muted-panel: `#F1F4F8`
  - line: `#D9E0E8`
  - line-strong: `#B8C3D1`
  - text: `#1F2A37`
  - subtext: `#657184`
- **Status colors:**
  - secure / controlled: `#1F5C4C`
  - syncing: `#2F6BFF`
  - caution: `#A35A1E`
  - error: `#A63C35`
- **Dark mode:** defer. Do not design around dark mode for this phase.

## Layout
- **Home page:** Tencent-like application shell with left navigation, top search, quick create, and dense recent-document table.
- **Editor page:** top bar + sheet canvas + right dock.
- **Home page hierarchy:**
  - first: search, quick create, recent work
  - second: controlled workspace cues
  - third: template/admin utilities
- **Editor page hierarchy:**
  - first: sheet canvas
  - second: toolbar and sheet tabs
  - third: docked workflow tools
- **Responsive rule:** do not pretend full spreadsheet editing is comfortable on phone.

## Spacing
- **Base unit:** `8px`
- **Density:** dense but breathable, closer to Tencent Docs than to enterprise admin dashboards
- **Scale:**
  - xs: `4px`
  - sm: `8px`
  - md: `12px`
  - lg: `16px`
  - xl: `24px`
  - 2xl: `32px`
  - 3xl: `48px`

## Shape
- **Border radius:**
  - control: `6px`
  - panel: `10px`
  - dock / popover: `12px`
  - pill: `999px`
- **Rule:** do not apply large radius everywhere. This is not bubbly SaaS.

## Motion
- **Approach:** invisible-first.
- **Use:** hover clarity, route continuity, dock reveal, loading skeleton shimmer.
- **Avoid:** decorative motion, parallax, floating ornaments, dramatic transitions.

## Home Page Rules
- Structure should be instantly legible to a Tencent Docs user.
- First viewport should be 80% familiarity, 20% trust signaling.
- Main area should prefer dense tables over decorative cards.
- Search must feel primary.
- "Sensitive workspace" or equivalent trust language should be present, but not dominate the page.
- Empty state must still preserve the same page skeleton and show one clear next action.

## Editor Page Rules
- The first 3 seconds should feel like entering a familiar spreadsheet.
- Sheet remains the unquestioned anchor.
- Right dock is subordinate to the grid.
- Specialized legal tools enter through top actions and dock tabs, not by replacing the editor shell.
- Plugin placeholders must look intentional, not unfinished.
- History, review, and AI should read as controlled expansions of the same workspace.

## Responsive & Accessibility
- Desktop is primary.
- Tablet keeps the spreadsheet, but the right dock becomes overlay or narrower slide-over.
- Phone:
  - home page remains usable
  - public forms remain fully usable
  - authenticated editor defaults to view-first mode, not full editing parity
- Minimum touch target: `44px`
- Full keyboard navigation required for:
  - home list actions
  - sheet top actions
  - dock tabs
  - form controls
- Color is never the only signal.
- Route transitions and reconnect/auth states must keep clear live-region messaging.

## Components
- **Primary button:** Tencent-like blue fill, compact shape, reserved for the clearest forward action
- **Secondary button:** light surface with line border
- **Ghost button:** low-chrome utility control
- **Recent-file row:** dense, calm, metadata-heavy
- **Search input:** large enough to dominate the home header without becoming marketing hero UI
- **Right dock:** clean white panel with thin border and tight header
- **Status chip:** compact pill, muted by default
- **Sensitive workspace tag:** subtle trust label, never a screaming warning badge

## Interaction Model
- Users should move from home to sheet without a visual cliff.
- Product-specific power appears progressively.
- Every unfinished feature still needs designed copy, hierarchy, and a clear reason for existing.
- "Looks broken" is unacceptable.

## What To Avoid
- Airtable/Grist-style productized data-workbench visual language as the primary inspiration
- Generic enterprise admin dashboards
- Three-column feature-card rhythms inside authenticated pages
- Purple/indigo startup gradients
- Overuse of serif typography
- Oversized radius on every control
- Decorative icon circles
- Heavy card chrome around list/table content
- Turning the home page into a legal portal instead of a familiar document workspace

## Decision Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-10 | Replaced industrial workbook posture with Tencent-compatible familiarity | Product strategy depends on reducing switching cost first |
| 2026-04-10 | Set home page to 80% familiarity, 20% trust signal | Users should not feel forced to learn a new tool on arrival |
| 2026-04-10 | Set editor differentiation to progressive reveal | Specialized legal value should appear after users feel oriented |
| 2026-04-10 | Switched to Plex + Noto typography stack | More document-native and professional than the previous editorial-industrial mix |
| 2026-04-10 | Reframed color system around Tencent-like blue plus legal trust accent | Needed continuity with user habit while preserving a more controlled tone |
