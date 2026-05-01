<script lang="ts">
  import EmptyState from "../../../components/EmptyState.svelte";
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import RecordForm from "../components/RecordForm.svelte";
  import { coerceGridFieldValue, validateGridFieldValue } from "../../../../shared/field-schema";

  type FormMode = "edit" | "fill";

  let draft = $state<Record<string, unknown>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let lastSavedAt = $state<string | null>(null);
  let mode = $state<FormMode>("edit");

  function emptyDraft() {
    return Object.fromEntries(
      editorStore.columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]),
    );
  }

  $effect(() => {
    void editorStore.activeSheetId;
    void editorStore.columns;
    draft = emptyDraft();
    fieldErrors = {};
  });

  function reset() {
    draft = emptyDraft();
    fieldErrors = {};
  }

  async function submit() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    const values: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const col of editorStore.columns) {
      const coerced = coerceGridFieldValue(draft[col.key], col);
      const errors = validateGridFieldValue(coerced, col);
      values[col.key] = coerced;
      if (errors.length) nextErrors[col.key] = errors[0];
    }
    fieldErrors = nextErrors;
    if (Object.keys(nextErrors).length) return;

    const ok = await editorStore.saveRows([{ values }]);
    if (ok) {
      reset();
      lastSavedAt = new Date().toLocaleTimeString();
    }
  }
</script>

<div class="form-view">
  <aside class="form-fields">
    <div class="panel-head">
      <strong>可添加字段</strong>
      <button type="button" disabled>全部移出</button>
    </div>

    {#if editorStore.columns.length}
      <div class="all-added">所有字段都已添加至表单</div>
      <div class="field-list">
        {#each editorStore.columns as col}
          <button type="button" onclick={() => editorUi.openFieldEditor(col.key)}>
            <span>{col.label}</span>
            <em>{col.fieldType}</em>
          </button>
        {/each}
      </div>
    {:else}
      <div class="all-added">暂无可用字段</div>
    {/if}

    <button class="add-field" type="button" disabled={appState.readOnly || !editorStore.columns.length}>
      <Icon name="plus" size={14} color="var(--primary)" />
      添加新字段到表单
      <span>›</span>
    </button>
  </aside>

  <main class="form-canvas">
    <div class="form-tabs">
      <button class:active={mode === "edit"} onclick={() => (mode = "edit")}>编辑表单</button>
      <button class:active={mode === "fill"} onclick={() => (mode = "fill")}>填写表单</button>
    </div>

    <div class="form-paper">
      <header class="form-header">
        <div>
          <strong>{mode === "edit" ? "表单设计" : "填写表单"}</strong>
          <span>按当前表格字段类型渲染输入控件，提交后在原表格新增一条记录</span>
        </div>
        {#if lastSavedAt}
          <span class="saved-tip">已保存 · {lastSavedAt}</span>
        {/if}
      </header>

      <div class="form-body">
        {#if editorStore.columns.length}
          <RecordForm
            columns={editorStore.columns}
            values={draft}
            errors={fieldErrors}
            disabled={mode === "edit" || appState.readOnly}
            dense
          />
        {:else}
          <EmptyState icon="info" title="暂无字段" desc="请先在表格字段中定义当前 Sheet 的字段" />
        {/if}
      </div>

      <footer class="form-footer">
        {#if editorStore.saveError}
          <span class="form-error">{editorStore.saveError}</span>
        {:else if mode === "edit"}
          <span class="form-meta">编辑模式用于预览控件；切换到填写表单后可提交数据。</span>
        {/if}
        <button class="secondary-btn" onclick={reset} disabled={editorStore.saving || mode === "edit"}>清空</button>
        <button
          class="primary-btn"
          onclick={submit}
          disabled={mode === "edit" || appState.readOnly || editorStore.saving || !editorStore.columns.length}
        >
          提交记录
        </button>
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
    <p>开启后，其他人可通过生成的分享链接填写当前表单，无需访问工作簿。</p>
    <div class="divider"></div>
    <span class="scope-title">填写范围</span>
    <label class="scope-row">
      谁可以填写
      <select disabled>
        <option>所有人可填写</option>
      </select>
    </label>
    <span class="scope-title">邀请填写</span>
    <div class="share-grid">
      <button><Icon name="link" size={22} />Copy Link</button>
      <button><Icon name="grid" size={22} />QR Code</button>
      <button><span>微</span>WeChat</button>
      <button><span>QQ</span>QQ</button>
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

  .panel-head button {
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
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

  .field-list button,
  .add-field {
    display: flex;
    width: 100%;
    min-height: 42px;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: #f8fafc;
    color: var(--text-2);
    font-size: 13px;
  }

  .field-list button {
    padding: 0 12px;
  }

  .field-list button:hover {
    border-color: var(--border);
    background: #fff;
  }

  .field-list em {
    color: var(--text-3);
    font-size: 11px;
    font-style: normal;
  }

  .add-field {
    margin-top: 22px;
    padding: 0 14px;
    color: var(--primary);
    justify-content: flex-start;
  }

  .add-field span {
    margin-left: auto;
    font-size: 20px;
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
  }

  .form-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 24px 28px 8px;
  }

  .form-header strong {
    display: block;
    color: var(--text-1);
    font-size: 18px;
    font-weight: 700;
  }

  .form-header span {
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

  .scope-row {
    display: grid;
    grid-template-columns: 88px 1fr;
    align-items: center;
    gap: 10px;
    margin-bottom: 22px;
    color: var(--text-1);
    font-size: 13px;
  }

  .scope-row select {
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fff;
    color: var(--text-1);
  }

  .share-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }

  .share-grid button {
    display: grid;
    min-width: 0;
    gap: 8px;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.2;
  }

  .share-grid button :global(svg),
  .share-grid button > span {
    display: grid;
    width: 48px;
    height: 48px;
    place-items: center;
    border-radius: 8px;
    background: #f2f4f7;
    color: var(--text-1);
    font-weight: 800;
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
