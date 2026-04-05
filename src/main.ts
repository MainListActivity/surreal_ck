import './styles/design-system.css';
import './styles/global.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app was not found.');
}

app.innerHTML = `
  <div class="app-shell">
    <aside class="left-rail">
      <div>
        <p class="eyebrow">surreal_ck</p>
        <h1 class="workbook-title">Graph workbook</h1>
      </div>
      <nav class="rail-section" aria-label="Primary">
        <button class="rail-button rail-button--active" type="button">Workbook</button>
        <button class="rail-button" type="button">Templates</button>
        <button class="rail-button" type="button">Intake Forms</button>
        <button class="rail-button" type="button">Admin</button>
      </nav>
      <div class="rail-meta">
        <span class="status-chip">SCaffold</span>
        <p>Vite, SurrealDB, and design tokens are wired. Workbook runtime lands next.</p>
      </div>
    </aside>
    <main class="canvas-shell">
      <header class="top-bar">
        <div>
          <p class="eyebrow">Workspace</p>
          <h2>Legal Entity Tracker</h2>
        </div>
        <div class="top-bar-meta">
          <span class="status-chip">SYNC IDLE</span>
          <button class="secondary-button" type="button">Invite members</button>
        </div>
      </header>
      <section class="sheet-stage" aria-label="Workbook preview">
        <div class="sheet-toolbar">
          <span class="mono-label">ACTIONS</span>
          <span class="mono-label">LIVE GRAPH</span>
          <span class="mono-label">SURREADLDB WSS</span>
        </div>
        <div class="sheet-grid" role="table" aria-label="Workbook preview grid">
          <div class="sheet-grid__row sheet-grid__row--header" role="row">
            <span>Entity</span>
            <span>Jurisdiction</span>
            <span>Relationship</span>
            <span>Formula</span>
          </div>
          <div class="sheet-grid__row" role="row">
            <span>Acme Holdings</span>
            <span>Delaware</span>
            <span>owns beta-llc</span>
            <span class="mono-cell">=GRAPH_TRAVERSE("company:acme", "owns", 2)</span>
          </div>
          <div class="sheet-grid__row" role="row">
            <span>Beta LLC</span>
            <span>Hong Kong</span>
            <span>controls gamma-inc</span>
            <span class="mono-cell">company:beta</span>
          </div>
          <div class="sheet-grid__row" role="row">
            <span>Gamma Inc</span>
            <span>Singapore</span>
            <span>filed_by intake:2026-04-05</span>
            <span class="mono-cell">person:chen</span>
          </div>
        </div>
      </section>
    </main>
    <aside class="sidebar-panel">
      <p class="eyebrow">Context Panel</p>
      <h2>Foundation notes</h2>
      <ul class="sidebar-list">
        <li>Design tokens map directly from DESIGN.md.</li>
        <li>Spike page is available at <code>/spike/collab-test.html</code>.</li>
        <li>Schema and Docker setup are ready for import and local boot.</li>
      </ul>
    </aside>
  </div>
`;
