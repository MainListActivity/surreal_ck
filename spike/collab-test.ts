import '../src/styles/design-system.css';
import '../src/styles/global.css';

type MutationRecord = {
  commandId: string;
  from: 'tab-a' | 'tab-b';
  params: Record<string, unknown>;
  at: string;
};

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing #app root for spike page.');
}

const state = {
  history: [] as MutationRecord[],
};

const exampleMutation = (from: 'tab-a' | 'tab-b', commandId: string): MutationRecord => ({
  commandId,
  from,
  params: {
    row: 1,
    column: 1,
    value: from === 'tab-a' ? 'Acme Holdings' : 'Beta LLC',
  },
  at: new Date().toISOString(),
});

const render = () => {
  root.innerHTML = `
    <main class="spike-layout">
      <section class="spike-hero">
        <p class="eyebrow">Week 0 spike</p>
        <h1 class="workbook-title">Univer mutation replay validation</h1>
        <p class="spike-copy">
          This page is the execution harness for the collaboration spike. Wire two Univer instances here,
          record emitted commands, and replay them through SurrealDB-backed live mutations.
        </p>
        <div class="spike-actions">
          <button class="secondary-button" id="emit-a" type="button">Simulate Tab A mutation</button>
          <button class="secondary-button" id="emit-b" type="button">Simulate Tab B mutation</button>
        </div>
      </section>
      <section class="spike-grid">
        <article class="spike-card">
          <p class="eyebrow">Planned capture path</p>
          <ol>
            <li>Mount two workbook instances with shared SurrealDB connection settings.</li>
            <li>Capture <code>CommandExecuted</code> events and ignore <code>fromCollab</code> replays.</li>
            <li>Insert whitelisted mutations into <code>spike_mutations</code>.</li>
            <li>LIVE subscribe in the sibling tab and replay with <code>executeCommand(..., { fromCollab: true })</code>.</li>
          </ol>
        </article>
        <article class="spike-card">
          <p class="eyebrow">Decision gate</p>
          <ul>
            <li>Confirm open-source Univer respects <code>fromCollab: true</code>.</li>
            <li>Verify formatting and other <code>syncOnly</code> commands are observable.</li>
            <li>Record fallback if more than three core commands fail replay cleanly.</li>
          </ul>
        </article>
      </section>
      <section class="spike-history">
        <div class="spike-history__header">
          <p class="eyebrow">Mutation log</p>
          <span class="status-chip">${state.history.length} recorded</span>
        </div>
        <pre class="spike-console">${JSON.stringify(state.history, null, 2)}</pre>
      </section>
    </main>
  `;

  const emitA = document.querySelector<HTMLButtonElement>('#emit-a');
  const emitB = document.querySelector<HTMLButtonElement>('#emit-b');

  emitA?.addEventListener('click', () => {
    state.history.unshift(exampleMutation('tab-a', 'sheet.command.set-range-values'));
    render();
  });

  emitB?.addEventListener('click', () => {
    state.history.unshift(exampleMutation('tab-b', 'sheet.command.insert-row'));
    render();
  });
};

render();
