<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { isWorkspaceAdmin as isWorkspaceAdminFn } from "../lib/permissions.svelte";
  import { getSurreal } from "../lib/surreal";
  import { getCurrentWorkspace } from "../lib/workspace-store.svelte";

  type QueryMode = "table" | "json";
  type PlainRow = Record<string, unknown>;

  const HISTORY_LIMIT = 12;

  let sql = $state("INFO FOR DB;");
  let result = $state<unknown[] | null>(null);
  let error = $state("");
  let loading = $state(false);
  let elapsedMs = $state<number | null>(null);
  let mode = $state<QueryMode>("json");
  let history = $state<string[]>([]);

  const workspace = $derived(getCurrentWorkspace());
  const canRun = $derived(isWorkspaceAdminFn());
  const historyKey = $derived(workspace ? `surreal-ck:admin-console:${workspace.slug}` : null);
  const resultJson = $derived(result ? stringify(result) : "");
  const tableRows = $derived(extractRows(result));
  const tableColumns = $derived(extractColumns(tableRows));
  const canShowTable = $derived(tableRows.length > 0 && tableColumns.length > 0);
  const resultCount = $derived(result ? result.length : 0);

  $effect(() => {
    if (!historyKey) {
      history = [];
      return;
    }
    history = readHistory(historyKey);
  });

  async function runQuery() {
    const trimmed = sql.trim();
    if (!trimmed || loading) return;

    if (!canRun) {
      error = "需要管理员权限。";
      return;
    }

    loading = true;
    error = "";
    result = null;
    elapsedMs = null;
    const startedAt = performance.now();

    try {
      const response = await getSurreal().queryRaw(trimmed);
      result = response;
      elapsedMs = Math.round(performance.now() - startedAt);
      history = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, HISTORY_LIMIT);
      writeHistory(historyKey, history);
      mode = canShowTable ? "table" : "json";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function onEditorKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runQuery();
    }
  }

  function reuseQuery(item: string) {
    sql = item;
    error = "";
  }

  function clearResult() {
    result = null;
    error = "";
    elapsedMs = null;
  }

  async function copyResult() {
    if (!resultJson) return;
    await navigator.clipboard?.writeText(resultJson);
  }

  function readHistory(key: string): string[] {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  function writeHistory(key: string | null, items: string[]) {
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(items));
    } catch {
      // localStorage may be unavailable in private mode; query execution should still work.
    }
  }

  function extractRows(value: unknown[] | null): PlainRow[] {
    if (!value) return [];

    for (const statement of value) {
      if (Array.isArray(statement) && statement.every(isPlainRow)) {
        return statement;
      }
      if (isPlainRow(statement)) {
        return [statement];
      }
    }

    return [];
  }

  function extractColumns(rows: PlainRow[]): string[] {
    const seen = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        seen.add(key);
      }
    }
    return [...seen].slice(0, 24);
  }

  function isPlainRow(value: unknown): value is PlainRow {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function stringify(value: unknown): string {
    try {
      return JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        return item;
      }, 2);
    } catch {
      return String(value);
    }
  }

  function preview(item: unknown): string {
    if (item === null || item === undefined) return "";
    if (typeof item === "string") return item;
    if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") return String(item);
    return stringify(item);
  }
</script>

<section class="console">
  <aside class="history">
    <div class="context">
      <h1>SQL 控制台</h1>
      <div class="meta">
        <span>{workspace?.name ?? workspace?.slug ?? "当前工作区"}</span>
        <span class:admin={canRun}>{workspace?.role ?? "unknown"}</span>
      </div>
    </div>

    <div class="history-list">
      <div class="history-title">历史</div>
      {#if history.length === 0}
        <div class="empty-history">暂无记录</div>
      {:else}
        {#each history as item}
          <button type="button" onclick={() => reuseQuery(item)} title={item}>{item}</button>
        {/each}
      {/if}
    </div>
  </aside>

  <main class="workspace">
    <header class="toolbar">
      <div>
        <strong>SurrealQL</strong>
        {#if elapsedMs !== null}
          <span>{elapsedMs} ms</span>
        {/if}
      </div>
      <div class="actions">
        <button type="button" class="secondary-btn" onclick={clearResult}>
          <Icon name="trash" size={13} />清空
        </button>
        <button type="button" class="primary-btn" disabled={loading || !sql.trim() || !canRun} onclick={runQuery}>
          <Icon name={loading ? "refresh" : "search"} size={13} color="#fff" />{loading ? "执行中" : "执行"}
        </button>
      </div>
    </header>

    <textarea
      bind:value={sql}
      spellcheck="false"
      onkeydown={onEditorKeydown}
      aria-label="SurrealQL 输入"
      disabled={!canRun}
    ></textarea>

    <section class="result-panel">
      <div class="result-head">
        <div>
          <strong>结果</strong>
          {#if result}
            <span>{resultCount} 条语句结果</span>
          {/if}
        </div>

        <div class="result-actions">
          <button
            type="button"
            class:selected={mode === "table"}
            class="segmented"
            disabled={!canShowTable}
            onclick={() => (mode = "table")}
          >表格</button>
          <button
            type="button"
            class:selected={mode === "json"}
            class="segmented"
            onclick={() => (mode = "json")}
          >JSON</button>
          <button type="button" class="icon-btn" disabled={!resultJson} title="复制结果" onclick={copyResult}>
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>

      {#if error}
        <pre class="error">{error}</pre>
      {:else if loading}
        <div class="placeholder">正在执行</div>
      {:else if !result}
        <div class="placeholder">等待执行</div>
      {:else if mode === "table" && canShowTable}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {#each tableColumns as column}
                  <th>{column}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each tableRows as row}
                <tr>
                  {#each tableColumns as column}
                    <td>{preview(row[column])}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <pre class="json">{resultJson}</pre>
      {/if}
    </section>
  </main>
</section>

<style>
  .console {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
  }

  .history {
    display: flex;
    width: 224px;
    flex-shrink: 0;
    flex-direction: column;
    gap: 22px;
    padding: 18px 14px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  h1 {
    margin: 0;
    color: var(--text-1);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .meta {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .meta span {
    max-width: 100%;
    overflow: hidden;
    padding: 3px 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta .admin {
    border-color: rgba(0, 180, 42, .24);
    background: var(--success-bg);
    color: #168a2f;
  }

  .history-list {
    min-height: 0;
    overflow: auto;
  }

  .history-title {
    margin-bottom: 8px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
  }

  .empty-history {
    padding: 10px 8px;
    color: var(--text-3);
    font-size: 12px;
  }

  .history-list button {
    display: block;
    width: 100%;
    margin-bottom: 6px;
    overflow: hidden;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--soft);
    color: var(--text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.35;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .history-list button:hover {
    border-color: var(--border-dark);
    background: var(--surface);
  }

  .workspace {
    display: grid;
    min-width: 0;
    flex: 1;
    grid-template-rows: auto minmax(180px, 34%) minmax(0, 1fr);
    gap: 14px;
    padding: 20px;
    overflow: hidden;
  }

  .toolbar,
  .result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .toolbar strong,
  .result-head strong {
    display: inline-block;
    color: var(--text-1);
    font-size: 13px;
  }

  .toolbar span,
  .result-head span {
    margin-left: 10px;
    color: var(--text-3);
    font-size: 12px;
  }

  .actions,
  .result-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .actions button {
    height: 32px;
    padding: 0 12px;
  }

  button:disabled,
  textarea:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  textarea {
    width: 100%;
    min-width: 0;
    height: 100%;
    resize: none;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    background: var(--surface);
    color: var(--text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
  }

  textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .result-panel {
    display: flex;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }

  .result-head {
    flex-shrink: 0;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .segmented {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .segmented.selected {
    border-color: var(--primary);
    background: var(--primary-light);
    color: var(--primary);
  }

  .placeholder {
    display: grid;
    flex: 1;
    place-items: center;
    color: var(--text-3);
    font-size: 13px;
  }

  .table-wrap {
    min-height: 0;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th,
  td {
    max-width: 320px;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-2);
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--soft);
    color: var(--text-1);
    font-weight: 650;
  }

  td {
    overflow: hidden;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .json,
  .error {
    flex: 1;
    min-height: 0;
    margin: 0;
    overflow: auto;
    padding: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .json {
    color: var(--text-2);
  }

  .error {
    background: var(--error-bg);
    color: var(--error);
  }

  @media (max-width: 860px) {
    .console {
      flex-direction: column;
    }

    .history {
      width: 100%;
      max-height: 174px;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .workspace {
      grid-template-rows: auto minmax(180px, 34vh) minmax(260px, 1fr);
      padding: 14px;
    }
  }
</style>
