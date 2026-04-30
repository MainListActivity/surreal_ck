<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import RecordForm from "../components/RecordForm.svelte";
  import { normalizeGridFieldConstraints } from "../../../../shared/field-schema";
  import type { GridColumnDef, GridFieldConstraints } from "../../../../shared/rpc.types";

  type FieldDraft = GridColumnDef & {
    optionsText?: string;
    constraints: GridFieldConstraints;
  };
  let draftError = $state<string | null>(null);

  let fieldDrafts = $state<FieldDraft[]>(
    editorStore.columns.map((col) => ({
      ...col,
      optionsText: col.options?.join("\n") ?? "",
      constraints: { ...col.constraints },
    })),
  );

  const previewColumns = $derived(
    fieldDrafts.map((field) => buildColumn(field, false)),
  );
  const previewValues = $derived(
    Object.fromEntries(previewColumns.map((field) => [field.key, field.fieldType === "checkbox" ? false : null])),
  );

  function close() {
    editorUi.showFields = false;
  }

  function addField() {
    const used = new Set(fieldDrafts.map((field) => field.key));
    let i = fieldDrafts.length + 1;
    while (used.has(`field_${i}`)) i++;
    fieldDrafts = [
      ...fieldDrafts,
      { key: `field_${i}`, label: "新字段", fieldType: "text", required: false, optionsText: "", constraints: {} },
    ];
  }

  function removeField(index: number) {
    fieldDrafts = fieldDrafts.filter((_, i) => i !== index);
  }

  async function save() {
    if (appState.readOnly) return;
    let columns: GridColumnDef[];
    try {
      columns = fieldDrafts.map((field) => buildColumn(field, true));
      draftError = null;
    } catch (err) {
      draftError = err instanceof Error ? err.message : String(err);
      return;
    }
    const ok = await editorStore.updateFields(columns);
    if (ok) close();
  }

  function buildColumn(field: FieldDraft, strict: boolean): GridColumnDef {
    const options = field.fieldType === "single_select"
      ? (field.optionsText ?? "").split("\n").map((opt) => opt.trim()).filter(Boolean)
      : undefined;

    let constraints: GridFieldConstraints | undefined;
    try {
      constraints = normalizeGridFieldConstraints(field.fieldType, field.constraints);
    } catch (err) {
      if (strict) throw err;
      constraints = undefined;
    }

    return {
      key: field.key,
      label: field.label,
      fieldType: field.fieldType,
      required: field.required,
      options,
      constraints,
    };
  }
</script>

<div class="modal-backdrop" role="presentation" onmousedown={close}>
  <div
    class="modal fields"
    role="dialog"
    aria-modal="true"
    aria-label="字段设置"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    <header>
      <strong>字段设置</strong>
      <button class="icon-btn" onclick={close}><Icon name="x" size={16} /></button>
    </header>
    <div class="field-editor">
      {#each fieldDrafts as field, index}
        <div class="field-card">
          <label>
            <span>字段名</span>
            <input bind:value={field.label} placeholder="显示名称" />
          </label>
          <label>
            <span>标识</span>
            <input bind:value={field.key} placeholder="field_key" />
          </label>
          <label>
            <span>类型</span>
            <select bind:value={field.fieldType}>
              <option value="text">文本</option>
              <option value="single_select">单选</option>
              <option value="number">数字</option>
              <option value="decimal">金额/小数</option>
              <option value="date">日期</option>
              <option value="checkbox">勾选</option>
            </select>
          </label>
          <label class="required-row">
            <input type="checkbox" bind:checked={field.required} />
            <span>必填</span>
          </label>
          {#if field.fieldType === "text"}
            <label>
              <span>最小长度</span>
              <input type="number" min="0" bind:value={field.constraints.minLength} />
            </label>
            <label>
              <span>最大长度</span>
              <input type="number" min="0" bind:value={field.constraints.maxLength} />
            </label>
          {/if}
          {#if field.fieldType === "single_select"}
            <label class="options-row">
              <span>选项，每行一个</span>
              <textarea bind:value={field.optionsText} rows="3"></textarea>
            </label>
            <label>
              <span>选项最大长度</span>
              <input type="number" min="0" bind:value={field.constraints.maxLength} />
            </label>
          {/if}
          {#if field.fieldType === "number" || field.fieldType === "decimal"}
            <label>
              <span>最小值</span>
              <input type="number" bind:value={field.constraints.min} />
            </label>
            <label>
              <span>最大值</span>
              <input type="number" bind:value={field.constraints.max} />
            </label>
            <label>
              <span>步长</span>
              <input type="number" min="0" step="any" bind:value={field.constraints.step} />
            </label>
          {/if}
          {#if field.fieldType === "date"}
            <label>
              <span>最早日期</span>
              <input type="date" bind:value={field.constraints.minDate} />
            </label>
            <label>
              <span>最晚日期</span>
              <input type="date" bind:value={field.constraints.maxDate} />
            </label>
          {/if}
          <button
            class="icon-btn danger"
            title="删除字段"
            onclick={() => removeField(index)}
            disabled={fieldDrafts.length <= 1}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      {/each}
    </div>
    <section class="preview-panel">
      <div class="preview-head">
        <strong>表单预览</strong>
        <span>预览会按当前字段类型和限制渲染，保存后同样映射到 DDL。</span>
      </div>
      <RecordForm columns={previewColumns} values={previewValues} dense={true} disabled={true} />
    </section>
    <footer>
      {#if editorStore.saveError}
        <span class="modal-error">{editorStore.saveError}</span>
      {:else if draftError}
        <span class="modal-error">{draftError}</span>
      {/if}
      <button class="secondary-btn" onclick={addField}>
        <Icon name="plus" size={13} />新增字段
      </button>
      <button class="primary-btn" onclick={save} disabled={editorStore.saving}>保存字段</button>
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .modal {
    max-height: 90vh;
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
  }

  .fields {
    width: min(760px, calc(100vw - 32px));
  }

  .modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }

  .field-editor {
    display: grid;
    gap: 10px;
    max-height: 62vh;
    overflow: auto;
    padding: 16px 20px;
  }

  .field-card {
    position: relative;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr)) 76px 32px;
    align-items: end;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }

  .field-card label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-3);
    font-size: 11px;
  }

  .required-row {
    display: flex;
    height: 34px;
    align-items: center;
    gap: 6px;
  }

  .required-row input {
    width: auto;
  }

  .required-row span {
    margin: 0;
  }

  .options-row {
    grid-column: 1 / -2;
  }

  .preview-panel {
    border-top: 1px solid var(--border);
    padding: 16px 20px 18px;
    background: #fbfcfe;
  }

  .preview-head {
    display: grid;
    gap: 4px;
    margin-bottom: 12px;
  }

  .preview-head strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .preview-head span {
    color: var(--text-3);
    font-size: 11px;
  }

  textarea {
    width: 100%;
    resize: vertical;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
  }

  input,
  select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  .danger {
    color: var(--error);
  }

  .fields footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  .modal-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }
</style>
