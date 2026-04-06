# Design System — surreal_ck

## Product Context
- **What this is:** A graph-powered collaborative spreadsheet for legal-finance work. It combines workbook-style data editing, graph traversal, public intake forms, and lightweight admin tooling in one product.
- **Who it's for:** Lawyers and adjacent professional operators handling ownership chains, entity structures, submissions, and relationship-heavy records.
- **Space/industry:** Legal tech, legal finance, collaborative data workspaces.
- **Project type:** Web app / workbook-centered professional tool.

## Aesthetic Direction
- **Direction:** Industrial / utilitarian with editorial restraint.
- **Decoration level:** Minimal in the app shell, intentional in first-run and confirmation moments.
- **Mood:** Calm, serious, trustworthy, operational. It should feel like a working instrument, not a startup demo and not a generic no-code SaaS admin.
- **Reference sites:** [Ironclad](https://ironcladapp.com/), [Airtable](https://www.airtable.com/), [Grist](https://www.getgrist.com/)
- **Preview artifact:** [/tmp/design-consultation-preview-surreal_ck.html](/tmp/design-consultation-preview-surreal_ck.html)

## Core Product Posture
- Workbook-first, not dashboard-first.
- The spreadsheet is the primary surface.
- Sidebars are attached tools, not separate mini-products.
- Trust comes from structure, state clarity, and restraint, not heavy decoration.
- Avoid generic SaaS energy: no purple gradients, no three-column feature-grid feel inside the app, no decorative icon circles, no inflated border radii everywhere.

## Typography
- **Display/Hero:** `Instrument Serif` — used sparingly for workbook titles, setup milestones, confirmation headings, and other trust-heavy moments.
- **Body:** `Source Sans 3` — default for labels, forms, panel copy, body text, navigation, and table-adjacent UI.
- **UI/Labels:** `Source Sans 3`
- **Data/Tables:** `Geist Mono` — used for record IDs, formulas, sync state, and structured values where precision matters.
- **Code:** `Geist Mono`
- **Loading:** Google Fonts
  - `https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Source+Sans+3:wght@400;500;600;700&family=Geist+Mono:wght@400;500;700&display=swap`
- **Scale:**
  - hero: `clamp(3rem, 6vw, 5.8rem)`
  - h1/hub heading: `clamp(2rem, 3vw, 3rem)`
  - h2/section title: `1.15rem`
  - body: `1.05rem`
  - small/meta: `0.74rem - 0.82rem`

## Color
- **Approach:** Restrained. One dependable primary, one deliberate secondary, warm neutrals, semantic colors only where needed.
- **Primary:** `#174B47` — dependable action and trust color. Use for primary buttons, active state, sync-positive state, and key anchors.
- **Secondary:** `#A44A2A` — used for relationship emphasis, confirmations, and secondary calls that need gravity without looking like marketing CTA candy.
- **Neutrals:**
  - paper: `#FBFAF7`
  - parchment: `#F1EEE8`
  - parchment-2: `#E7E1D5`
  - line: `#D8D2C7`
  - line-strong: `#B8B0A2`
  - ink: `#1A1F1E`
  - muted: `#6B706F`
- **Semantic:**
  - success: `#1F6B52`
  - warning: `#B36A1D`
  - error: `#A23B32`
  - info: `#2E5B7A`
- **Dark mode:** Use the same hierarchy, but reduce contrast spikes and preserve the warm-neutral logic.
  - paper: `#141817`
  - parchment: `#1B211F`
  - parchment-2: `#222A27`
  - line: `#31403A`
  - line-strong: `#4A5F57`
  - ink: `#EDF0EA`
  - muted: `#A1AAA4`
  - primary: `#6DB5A7`
  - secondary: `#DE8A65`

## Spacing
- **Base unit:** `8px`
- **Density:** Comfortable-compact. This is a workbench, not a sparse marketing site.
- **Scale:**
  - 2xs: `2px`
  - xs: `4px`
  - sm: `8px`
  - md: `16px`
  - lg: `24px`
  - xl: `32px`
  - 2xl: `48px`
  - 3xl: `64px`

## Layout
- **Approach:** Hybrid. Strict and stable inside the app shell, slightly more composed in first-run/template and public form states.
- **Grid:**
  - desktop: workbook shell with left rail, primary sheet canvas, single contextual sidebar
  - tablet: keep workbook available, reduce density, sidebar becomes slide-over
  - phone: authenticated workbook defaults to record-list/detail reading mode, not raw grid
- **Border radius:**
  - sm: `8px`
  - md: `14px`
  - lg: `22px`
  - xl: `30px`
  - pill: `999px`
- **Surface rules:**
  - Spreadsheet remains the visual anchor.
  - Cards only when a thing is actually a contained interaction.
  - Side panels should feel docked, not floating and ornamental.
  - Decorative shadows are subtle and removable.

## Motion
- **Approach:** Minimal-functional
- **Easing:**
  - enter: `ease-out`
  - exit: `ease-in`
  - move: `ease-in-out`
- **Duration:**
  - micro: `50ms - 100ms`
  - short: `120ms - 180ms`
  - medium: `180ms - 260ms`
  - long: `260ms - 400ms`
- **Usage:**
  - hover and focus feedback only when it improves clarity
  - panel open/close should feel deliberate, not theatrical
  - no decorative motion in the workbook shell

## Workbook Interaction Model

### Source Sheets vs Action Sheets
- **Source sheets** hold system truth. They map closely to actual entities, relations, submissions, and imported records.
- **Action sheets** are task-oriented operational surfaces built on top of source data so users can review, triage, and complete work quickly.

### Action Sheet Rule
- A workbook may include both source sheets and action sheets.
- If a workbook supports a repeatable human workflow, it should usually expose at least one action sheet.
- Action sheets should still be sheets, not dashboards. They inherit workbook conventions and keep the user inside the spreadsheet mental model.

### Action Sheet Characteristics
- frozen critical columns
- clear status-first ordering
- default filters and sorts
- row-level quick actions
- strong link to the right sidebar for detail and next-step actions
- limited, high-value formulas and computed helper columns

### Default Open Behavior
- First-time entry into a template workbook: open the action sheet by default.
- Return visit to an existing workbook: reopen the last viewed sheet.
- Model-building or admin-heavy workbook: default to a source sheet.
- Review / triage / operations workbook: default to an action sheet.

## Responsive & Accessibility
- Desktop/laptop gets the full workbook experience.
- Tablet preserves the workbook, but can reduce visible density.
- Phone keeps public forms fully usable and workbook access read-only by default.
- Phone workbook view should default to record list / detail reading mode with an explicit link to the original sheet.
- Minimum touch target: `44px`
- Keyboard access required for all sidebar actions, template picker actions, and form controls.
- Color is never the only signal for sync state, warning state, validation state, or submission state.
- Success, warning, and error banners must be available to assistive technologies via live regions.

## Components & States
- **Primary button:** deep green fill, paper text, reserved for the single clearest next action.
- **Secondary button:** soft tinted surface with colored text and border.
- **Ghost button:** transparent with clear border, used for attached tooling and reversible actions.
- **Status chip:** mono label, pill shape, restrained fill.
- **Workbook shell:** left rail + sheet canvas + single contextual sidebar.
- **Public form confirmation:** dedicated page/state, never a transient toast-only success.
- **Blank workspace:** empty sheet plus guided setup panel with exactly three first actions.

## What To Avoid
- Purple / violet / indigo gradient defaults
- Generic no-code platform cheerfulness
- Over-centered layouts inside the app shell
- Three-column marketing-grid rhythm leaking into workbook UI
- Thick decorative card chrome around tables
- Oversized radius on every surface
- Making phone spreadsheet editing look “supported” when it is really compromised

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-05 | Established workbook-first design system | The product's value is live work inside a spreadsheet, not a dashboard shell |
| 2026-04-05 | Chose `Instrument Serif` + `Source Sans 3` + `Geist Mono` | Balances legal-finance trust, operational readability, and data precision |
| 2026-04-05 | Chose deep green + rust + warm neutral palette | Avoids generic AI SaaS aesthetics and supports a serious professional tone |
| 2026-04-05 | Defined phone workbook mode as read-only record-list-first | Small screens should preserve continuity without pretending full editing parity |
| 2026-04-05 | Added action sheet rule inside workbooks | Users need operational sheets for real work, not only raw source tables |
