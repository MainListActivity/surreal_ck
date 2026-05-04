<script lang="ts">
  import EmptyState from "../../../components/EmptyState.svelte";
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import RecordForm from "../components/RecordForm.svelte";
  import type { GridColumnDef } from "../../../../shared/rpc.types";

  type FormMode = "edit" | "fill";

  let draft = $state<Record<string, unknown>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let lastSavedAt = $state<string | null>(null);
  let mode = $state<FormMode>("edit");

  // 表单封面 / 详细说明（草稿态，待持久化到 form_definition.cover_url / description）
  let cover = $state<string>("");
  let description = $state<string>("");

  // 用户主动加入表单的非必填字段顺序（必填字段不进这个数组，强制由 $derived 拼接）
  // 用 sheetId 作为 key 隔离不同 sheet 的字段顺序
  let optionalOrderBySheet = $state<Record<string, string[]>>({});
  let lastSheetId = $state<string | null>(null);

  // 拖拽中的字段 key（用于编辑模式下重排）
  let draggingKey = $state<string | null>(null);
  let dragOverKey = $state<string | null>(null);
  const tableView = $derived(editorStore.tableViewAdapter);

  // sheet 切换时重置草稿；不动 fieldOrder（保留每个 sheet 的字段编排）
  $effect(() => {
    const sid = editorStore.activeSheetId;
    if (sid !== lastSheetId) {
      lastSheetId = sid;
      draft = tableView.emptyValues();
      fieldErrors = {};
    }
  });

  const sheetKey = $derived(editorStore.activeSheetId ?? "_");
  const optionalOrder = $derived(optionalOrderBySheet[sheetKey] ?? []);

  // 字段总顺序：必填字段（按 columns 原顺序） + 用户加入的非必填字段（按 optionalOrder）
  // 自动剔除已不存在的列
  const fieldOrder = $derived.by(() => {
    const cols = tableView.visibleColumns;
    const validKeys = new Set(cols.map((c) => c.key));
    const required = cols.filter((c) => c.required).map((c) => c.key);
    const optional = optionalOrder.filter((k) => validKeys.has(k) && !required.includes(k));
    return [...required, ...optional];
  });

  const includedColumns = $derived(
    fieldOrder
      .map((key) => tableView.getColumn(key))
      .filter((c): c is GridColumnDef => Boolean(c)),
  );

  const availableColumns = $derived(
    tableView.visibleColumns.filter((c) => !c.required && !fieldOrder.includes(c.key)),
  );

  function setOptionalOrder(next: string[]) {
    optionalOrderBySheet = { ...optionalOrderBySheet, [sheetKey]: next };
  }

  function addField(key: string) {
    const col = tableView.getColumn(key);
    if (!col || col.required) return;
    if (optionalOrder.includes(key)) return;
    setOptionalOrder([...optionalOrder, key]);
  }

  function removeField(key: string) {
    const col = tableView.getColumn(key);
    if (!col || col.required) return;
    setOptionalOrder(optionalOrder.filter((k) => k !== key));
  }

  function moveField(key: string, delta: -1 | 1) {
    // 只允许在非必填字段之间排序
    const idx = optionalOrder.indexOf(key);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= optionalOrder.length) return;
    const next = [...optionalOrder];
    [next[idx], next[target]] = [next[target], next[idx]];
    setOptionalOrder(next);
  }

  // 把 sourceKey 移到 targetKey 之前（仅在非必填字段之间生效）
  function reorderField(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) return;
    const from = optionalOrder.indexOf(sourceKey);
    const to = optionalOrder.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    const next = [...optionalOrder];
    next.splice(from, 1);
    const insertAt = next.indexOf(targetKey);
    next.splice(insertAt, 0, sourceKey);
    setOptionalOrder(next);
  }

  function onDragStart(event: DragEvent, key: string) {
    draggingKey = key;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    }
  }

  function onDragOver(event: DragEvent, key: string) {
    if (!draggingKey) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOverKey = key;
  }

  function onDrop(event: DragEvent, key: string) {
    event.preventDefault();
    const src = draggingKey ?? event.dataTransfer?.getData("text/plain") ?? null;
    if (src) reorderField(src, key);
    draggingKey = null;
    dragOverKey = null;
  }

  function onDragEnd() {
    draggingKey = null;
    dragOverKey = null;
  }

  function reset() {
    draft = tableView.emptyValues();
    fieldErrors = {};
  }

  async function submit() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    const values: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const col of includedColumns) {
      const coerced = tableView.coerceValue(col, draft[col.key]);
      const error = tableView.validateValue(col, coerced);
      values[col.key] = coerced;
      if (error) nextErrors[col.key] = error;
    }
    fieldErrors = nextErrors;
    if (Object.keys(nextErrors).length) return;

    const ok = await tableView.actions.saveRows([{ values }]);
    if (ok) {
      reset();
      lastSavedAt = new Date().toLocaleTimeString();
    }
  }

  function copyAppLink() {
    const link = `surrealck://forms/${editorStore.activeSheetId ?? ""}`;
    void navigator.clipboard?.writeText(link);
    editorUi.clipboardStatus = `已复制 App 链接：${link}`;
  }

  function copyWebLink() {
    const link = `${location.origin}/forms/${editorStore.activeSheetId ?? ""}`;
    void navigator.clipboard?.writeText(link);
    editorUi.clipboardStatus = `已复制浏览器链接：${link}`;
  }
</script>

<div class="form-view">
  <aside class="form-fields">
    <div class="panel-head">
      <strong>可添加字段</strong>
      <span class="panel-hint">必填字段已强制纳入</span>
    </div>

    {#if availableColumns.length}
      <div class="field-list">
        {#each availableColumns as col}
          <button type="button" class="add-row" onclick={() => addField(col.key)}>
            <span class="col-name">{col.label}</span>
            <em>{col.fieldType}</em>
            <Icon name="plus" size={14} color="var(--primary)" />
          </button>
        {/each}
      </div>
    {:else if tableView.visibleColumns.length}
      <div class="all-added">所有非必填字段都已添加至表单</div>
    {:else}
      <div class="all-added">暂无可用字段</div>
    {/if}
  </aside>

  <main class="form-canvas">
    <div class="form-tabs">
      <button class:active={mode === "edit"} onclick={() => (mode = "edit")}>编辑表单</button>
      <button class:active={mode === "fill"} onclick={() => (mode = "fill")}>填写表单</button>
    </div>

    <div class="form-paper">
      {#if mode === "edit"}
        <section class="cover-edit">
          <label class="cover-label">
            <span>表单封面图 URL</span>
            <input
              type="text"
              placeholder="https://… 留空则不展示封面"
              value={cover}
              oninput={(e) => (cover = e.currentTarget.value)}
            />
          </label>
        </section>
      {:else if cover}
        <div class="cover-preview" style="background-image: url({cover});"></div>
      {/if}

      <header class="form-header">
        <div class="form-title-block">
          <strong>{mode === "edit" ? "表单设计" : "填写表单"}</strong>
          {#if mode === "edit"}
            <textarea
              class="desc-input"
              placeholder="表单详细说明（向填写人说明用途、注意事项等）"
              value={description}
              oninput={(e) => (description = e.currentTarget.value)}
              rows="3"
            ></textarea>
          {:else if description}
            <p class="desc-show">{description}</p>
          {:else}
            <span class="desc-empty">提交后会在原表格新增一条记录</span>
          {/if}
        </div>
        {#if lastSavedAt}
          <span class="saved-tip">已保存 · {lastSavedAt}</span>
        {/if}
      </header>

      <div class="form-body">
        {#if includedColumns.length}
          {#if mode === "edit"}
            <ul class="reorder-list">
              {#each includedColumns as col, i (col.key)}
                <li
                  draggable="true"
                  class:dragging={draggingKey === col.key}
                  class:drag-over={dragOverKey === col.key && draggingKey !== col.key}
                  ondragstart={(e) => onDragStart(e, col.key)}
                  ondragover={(e) => onDragOver(e, col.key)}
                  ondrop={(e) => onDrop(e, col.key)}
                  ondragend={onDragEnd}
                  ondragleave={() => (dragOverKey = null)}
                >
                  <span class="drag-handle" aria-hidden="true">⋮⋮</span>
                  <span class="reorder-label">
                    {col.label}
                    {#if col.required}<b>*</b>{/if}
                    <em>{col.fieldType}</em>
                  </span>
                  <span class="reorder-actions">
                    <button type="button" disabled={i === 0} onclick={() => moveField(col.key, -1)} title="上移">↑</button>
                    <button type="button" disabled={i === includedColumns.length - 1} onclick={() => moveField(col.key, 1)} title="下移">↓</button>
                    <button
                      type="button"
                      class="remove"
                      disabled={col.required}
                      onclick={() => removeField(col.key)}
                      title={col.required ? "必填字段无法移除" : "从表单移除"}
                    >×</button>
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <RecordForm
              columns={includedColumns}
              values={draft}
              errors={fieldErrors}
              disabled={appState.readOnly}
              dense
            />
          {/if}
        {:else}
          <EmptyState icon="info" title="暂无字段" desc="请先在表格字段中定义当前 Sheet 的字段或将必填字段添加到表单" />
        {/if}
      </div>

      <footer class="form-footer">
        {#if editorStore.saveError}
          <span class="form-error">{editorStore.saveError}</span>
        {:else if mode === "edit"}
          <span class="form-meta">必填字段已自动纳入；可拖动 ⋮⋮ 调整顺序，切换到"填写表单"可提交数据。</span>
        {/if}
        {#if mode === "fill"}
          <button class="secondary-btn" onclick={reset} disabled={editorStore.saving}>清空</button>
          <button
            class="primary-btn"
            onclick={submit}
            disabled={appState.readOnly || editorStore.saving || !includedColumns.length}
          >
            提交记录
          </button>
        {/if}
      </footer>
    </div>
  </main>

  <aside class="publish-card">
    <div class="publish-head">
      <strong>Publish</strong>
      <label class="publish-switch">
        <input type="checkbox" checked disabled />
        <span></span>
      </label>
    </div>
    <p>开启后，其他人可通过下方链接填写当前表单，无需访问工作簿。</p>
    <div class="divider"></div>
    <span class="scope-title">邀请填写</span>
    <div class="share-grid">
      <button type="button" onclick={copyAppLink}>
        <Icon name="link" size={22} />
        App 链接
      </button>
      <button type="button" onclick={copyWebLink}>
        <Icon name="globe" size={22} />
        浏览器链接
      </button>
    </div>
  </aside>
</div>

<style>
  .form-view {
    position: relative;
    display: grid;
    grid-template-columns: 300px minmax(420px, 1fr) 300px;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: linear-gradient(90deg, #fff 0 300px, #f5f6f8 300px);
  }

  .form-fields {
    min-width: 0;
    overflow: auto;
    padding: 28px 24px;
    border-right: 1px solid var(--border);
    background: #fff;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-1);
    font-size: 13px;
  }

  .panel-hint {
    color: var(--text-3);
    font-size: 11px;
  }

  .all-added {
    display: grid;
    height: 110px;
    margin-top: 24px;
    place-items: center;
    border: 1px dashed #d8dde6;
    border-radius: 8px;
    background: #fafbfc;
    color: var(--text-3);
    font-size: 13px;
  }

  .field-list {
    display: grid;
    gap: 8px;
    margin-top: 16px;
  }

  .add-row {
    display: flex;
    width: 100%;
    min-height: 42px;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: #f8fafc;
    color: var(--text-2);
    font-size: 13px;
  }

  .add-row:hover {
    border-style: solid;
    border-color: var(--primary);
    background: #fff;
  }

  .add-row .col-name {
    flex: 1;
    text-align: left;
  }

  .add-row em {
    color: var(--text-3);
    font-size: 11px;
    font-style: normal;
  }

  .form-canvas {
    min-width: 0;
    overflow: auto;
    padding: 0 56px 48px;
  }

  .form-tabs {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    height: 58px;
    align-items: flex-end;
    justify-content: center;
    gap: 28px;
    background: #f5f6f8;
    box-shadow: 0 1px 0 var(--border);
  }

  .form-tabs button {
    position: relative;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 650;
  }

  .form-tabs button.active {
    color: var(--text-1);
  }

  .form-tabs button.active::after {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 3px;
    border-radius: 999px;
    background: var(--primary);
    content: "";
  }

  .form-paper {
    width: min(760px, 100%);
    margin: 26px auto 0;
    border-radius: 4px;
    background: var(--surface);
    box-shadow: 0 1px 0 rgba(15, 23, 42, .04);
    overflow: hidden;
  }

  .cover-edit {
    padding: 18px 28px 0;
  }

  .cover-label {
    display: grid;
    gap: 6px;
    color: var(--text-2);
    font-size: 12px;
  }

  .cover-label input {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fbfbfc;
    color: var(--text-1);
    font-size: 13px;
  }

  .cover-preview {
    width: 100%;
    height: 160px;
    background: #f2f4f7 center / cover no-repeat;
  }

  .form-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 20px 28px 8px;
  }

  .form-title-block {
    flex: 1;
    min-width: 0;
  }

  .form-title-block strong {
    display: block;
    color: var(--text-1);
    font-size: 18px;
    font-weight: 700;
  }

  .desc-input {
    width: 100%;
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fbfbfc;
    color: var(--text-1);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
  }

  .desc-show {
    margin: 6px 0 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .desc-empty {
    display: block;
    margin-top: 4px;
    color: var(--text-3);
    font-size: 12px;
  }

  .saved-tip {
    color: var(--primary);
    font-size: 12px;
    font-weight: 600;
  }

  .form-body {
    padding: 16px 28px 26px;
  }

  .reorder-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .reorder-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: #fbfbfc;
    transition: border-color .12s ease, background .12s ease, opacity .12s ease, transform .12s ease;
  }

  .reorder-list li.dragging {
    opacity: .4;
  }

  .reorder-list li.drag-over {
    border-color: var(--primary);
    background: var(--primary-light);
  }

  .drag-handle {
    display: inline-grid;
    place-items: center;
    width: 16px;
    color: var(--text-3);
    font-size: 14px;
    line-height: 1;
    letter-spacing: -2px;
    cursor: grab;
    user-select: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .reorder-label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
  }

  .reorder-label em {
    color: var(--text-3);
    font-size: 11px;
    font-style: normal;
    font-weight: 500;
  }

  .reorder-label b {
    color: var(--error);
  }

  .reorder-actions {
    display: flex;
    gap: 4px;
  }

  .reorder-actions button {
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fff;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1;
  }

  .reorder-actions button:disabled {
    opacity: .4;
    cursor: not-allowed;
  }

  .reorder-actions .remove {
    color: var(--error);
  }

  .form-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 28px 24px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .form-footer button {
    padding: 8px 20px;
  }

  .form-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }

  .form-meta {
    margin-right: auto;
    color: var(--text-3);
    font-size: 12px;
  }

  .publish-card {
    align-self: start;
    margin: 58px 16px 0 0;
    padding: 22px 24px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(255, 255, 255, .94);
    box-shadow: 0 18px 46px rgba(15, 23, 42, .16);
  }

  .publish-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-1);
    font-size: 18px;
  }

  .publish-card p {
    margin: 12px 0 18px;
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.55;
  }

  .divider {
    height: 1px;
    margin-bottom: 18px;
    background: var(--border);
  }

  .publish-switch {
    position: relative;
    display: inline-flex;
  }

  .publish-switch input {
    position: absolute;
    opacity: 0;
  }

  .publish-switch span {
    width: 38px;
    height: 22px;
    border-radius: 999px;
    background: var(--primary);
  }

  .publish-switch span::after {
    display: block;
    width: 18px;
    height: 18px;
    margin: 2px 2px 2px 18px;
    border-radius: 50%;
    background: #fff;
    content: "";
  }

  .scope-title {
    display: block;
    margin: 0 0 10px;
    color: var(--text-3);
    font-size: 12px;
  }

  .share-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .share-grid button {
    display: grid;
    min-width: 0;
    gap: 8px;
    place-items: center;
    padding: 12px 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: #fff;
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.2;
  }

  .share-grid button:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .share-grid button :global(svg) {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 8px;
    background: #f2f4f7;
    color: var(--text-1);
  }

  @media (max-width: 1120px) {
    .form-view {
      grid-template-columns: 240px minmax(0, 1fr);
    }

    .publish-card {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .form-view {
      display: flex;
      overflow: auto;
    }

    .form-fields {
      display: none;
    }

    .form-canvas {
      width: 100%;
      padding: 0 16px 28px;
    }
  }
</style>
