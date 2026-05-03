<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import SelectMenu from "../../../components/SelectMenu.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import { getFieldTypeMeta } from "../lib/field-type-meta";
  import { normalizeGridFieldConstraints } from "../../../../shared/field-schema";
  import {
    DATE_FORMAT_PRESETS,
    DEFAULT_DATE_FORMAT,
    formatDateValue,
  } from "../../../../shared/date-format";
  import DatePicker from "../../../components/DatePicker.svelte";
  import type { GridColumnDef, GridFieldConstraints } from "../../../../shared/rpc.types";

  let { fieldKey }: { fieldKey: string } = $props();

  type FieldDraft = GridColumnDef & {
    optionsText?: string;
    constraints: GridFieldConstraints;
  };

  const fieldTypeOptions = [
    { value: "text", label: "文本", icon: "textType" },
    { value: "single_select", label: "单选", icon: "list" },
    { value: "number", label: "数字", icon: "hash" },
    { value: "decimal", label: "金额/小数", icon: "coins" },
    { value: "date", label: "日期", icon: "calendar" },
    { value: "checkbox", label: "勾选", icon: "checkSquare" },
  ] as const;

  const dateFormatOptions = [
    ...DATE_FORMAT_PRESETS.map((preset) => ({
      value: preset.value,
      label: `${preset.label} (${preset.value})`,
    })),
    { value: "__custom__", label: "自定义…" },
  ];

  let draftError = $state<string | null>(null);
  let fieldDraft = $state<FieldDraft | null>(null);
  let dateFormatMode = $state<"preset" | "custom">("preset");

  $effect(() => {
    const source = editorStore.columns.find((col) => col.key === fieldKey);
    if (!source) {
      editorUi.closeFieldEditor();
      return;
    }

    const dateFormat = source.dateFormat?.trim() || DEFAULT_DATE_FORMAT;
    const isPreset = DATE_FORMAT_PRESETS.some((preset) => preset.value === dateFormat);

    fieldDraft = {
      ...source,
      optionsText: source.options?.join("\n") ?? "",
      constraints: { ...source.constraints },
      dateFormat,
    };
    dateFormatMode = isPreset ? "preset" : "custom";
    draftError = null;
  });

  function selectDateFormatPreset(value: string) {
    if (!fieldDraft) return;
    if (value === "__custom__") {
      dateFormatMode = "custom";
      return;
    }
    dateFormatMode = "preset";
    fieldDraft.dateFormat = value;
  }

  function updateDateConstraint(target: "minDate" | "maxDate", next: Date | null) {
    if (!fieldDraft) return;
    fieldDraft.constraints[target] = next ? next.toISOString() : undefined;
  }

  function close() {
    editorUi.closeFieldEditor();
  }

  async function save() {
    if (appState.readOnly || !fieldDraft) return;

    let updatedField: GridColumnDef;
    try {
      updatedField = buildColumn(fieldDraft, true);
      draftError = null;
    } catch (err) {
      draftError = err instanceof Error ? err.message : String(err);
      return;
    }

    const nextColumns = editorStore.columns.map((column) => column.key === fieldKey ? updatedField : column);
    const ok = await editorStore.updateFields(nextColumns);
    if (ok) close();
  }

  async function removeField() {
    if (appState.readOnly) return;
    if (editorStore.columns.length <= 1) {
      draftError = "至少保留一个字段";
      return;
    }

    const nextColumns = editorStore.columns.filter((column) => column.key !== fieldKey);
    const ok = await editorStore.updateFields(nextColumns);
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
      dateFormat: field.fieldType === "date" ? (field.dateFormat?.trim() || DEFAULT_DATE_FORMAT) : undefined,
    };
  }

  function getFieldTypeLabel(fieldType: GridColumnDef["fieldType"]) {
    return fieldTypeOptions.find((option) => option.value === fieldType)?.label ?? fieldType;
  }

  function hasRules(field: FieldDraft) {
    return field.fieldType !== "checkbox";
  }
</script>

<div class="modal-backdrop" role="presentation" onmousedown={close}>
  <div
    class="modal field-modal"
    role="dialog"
    aria-modal="true"
    aria-label="字段设置"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    {#if fieldDraft}
      <header>
        <div class="header-copy">
          <strong>字段设置</strong>
          <span>只编辑当前字段，后续可在同一入口扩展关联、权限与更多字段能力。</span>
        </div>
        <button class="icon-btn" onclick={close}><Icon name="x" size={16} /></button>
      </header>

      <div class="field-card">
        <div class="field-head">
          <div class="field-title">
            <span class="field-index">当前字段</span>
            <strong>{fieldDraft.label || "未命名字段"}</strong>
            <div class="field-badges">
              <span class="type-badge">
                <Icon name={getFieldTypeMeta(fieldDraft.fieldType).icon} size={12} />
                {getFieldTypeLabel(fieldDraft.fieldType)}
              </span>
              {#if fieldDraft.required}
                <span class="required-badge">必填</span>
              {/if}
            </div>
          </div>
          <button
            class="danger-link"
            onclick={removeField}
            disabled={editorStore.columns.length <= 1 || editorStore.saving}
          >
            删除字段
          </button>
        </div>

        <div class="field-grid base-grid">
          <label class="span-2">
            <span>字段名</span>
            <input bind:value={fieldDraft.label} placeholder="显示名称" />
          </label>
          <label class="span-2">
            <span>标识</span>
            <input bind:value={fieldDraft.key} placeholder="field_key" />
          </label>
          <label>
            <span>类型</span>
            <SelectMenu
              value={fieldDraft.fieldType}
              options={fieldTypeOptions}
              ariaLabel="字段类型"
              onChange={(next) => (fieldDraft.fieldType = next as GridColumnDef["fieldType"])}
            />
          </label>
          <div class="toggle-card">
            <span>校验</span>
            <label class="switch-row">
              <input type="checkbox" bind:checked={fieldDraft.required} />
              <span>必填字段</span>
            </label>
          </div>
        </div>

        {#if hasRules(fieldDraft)}
          <div class="constraints">
            <div class="section-head">
              <strong>字段约束</strong>
              <span>按当前字段类型配置输入边界，保证录入数据更稳定。</span>
            </div>

            {#if fieldDraft.fieldType === "text"}
              <div class="field-grid rule-grid">
                <label>
                  <span>最小长度</span>
                  <input type="number" min="0" bind:value={fieldDraft.constraints.minLength} />
                </label>
                <label>
                  <span>最大长度</span>
                  <input type="number" min="0" bind:value={fieldDraft.constraints.maxLength} />
                </label>
              </div>
            {/if}

            {#if fieldDraft.fieldType === "single_select"}
              <div class="field-grid rule-grid">
                <label class="span-2">
                  <span>选项列表</span>
                  <textarea bind:value={fieldDraft.optionsText} rows="4" placeholder={"待处理\n处理中\n已完成"}></textarea>
                </label>
                <label>
                  <span>选项最大长度</span>
                  <input type="number" min="0" bind:value={fieldDraft.constraints.maxLength} />
                </label>
              </div>
            {/if}

            {#if fieldDraft.fieldType === "number" || fieldDraft.fieldType === "decimal"}
              <div class="field-grid rule-grid">
                <label>
                  <span>最小值</span>
                  <input type="number" bind:value={fieldDraft.constraints.min} />
                </label>
                <label>
                  <span>最大值</span>
                  <input type="number" bind:value={fieldDraft.constraints.max} />
                </label>
                <label>
                  <span>步长</span>
                  <input type="number" min="0" step="any" bind:value={fieldDraft.constraints.step} />
                </label>
              </div>
            {/if}

            {#if fieldDraft.fieldType === "date"}
              <div class="field-grid rule-grid">
                <label class="span-2">
                  <span>显示格式</span>
                  <SelectMenu
                    value={dateFormatMode === "custom" ? "__custom__" : fieldDraft.dateFormat}
                    options={dateFormatOptions}
                    ariaLabel="日期显示格式"
                    onChange={selectDateFormatPreset}
                  />
                </label>
                {#if dateFormatMode === "custom"}
                  <label class="span-2">
                    <span>自定义格式</span>
                    <input
                      type="text"
                      placeholder="YYYY-MM-DD HH:mm:ss"
                      bind:value={fieldDraft.dateFormat}
                    />
                    <small class="hint">
                      预览：{formatDateValue(new Date(), fieldDraft.dateFormat) || "格式无效"}
                    </small>
                  </label>
                {/if}
                <label>
                  <span>最早日期</span>
                  <DatePicker
                    value={fieldDraft.constraints.minDate}
                    dateFormat={fieldDraft.dateFormat}
                    fullWidth
                    placeholder="不限"
                    onChange={(next) => updateDateConstraint("minDate", next)}
                  />
                </label>
                <label>
                  <span>最晚日期</span>
                  <DatePicker
                    value={fieldDraft.constraints.maxDate}
                    dateFormat={fieldDraft.dateFormat}
                    fullWidth
                    placeholder="不限"
                    onChange={(next) => updateDateConstraint("maxDate", next)}
                  />
                </label>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <footer>
        {#if editorStore.saveError}
          <span class="modal-error">{editorStore.saveError}</span>
        {:else if draftError}
          <span class="modal-error">{draftError}</span>
        {/if}
        <button class="secondary-btn" onclick={close}>取消</button>
        <button class="primary-btn" onclick={save} disabled={editorStore.saving}>保存字段</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(15, 23, 42, .22);
    backdrop-filter: blur(4px);
  }

  .modal {
    width: min(720px, calc(100vw - 32px));
    max-height: 90vh;
    overflow: visible;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: 0 24px 60px rgba(15, 23, 42, .18);
  }

  .modal header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border);
  }

  .header-copy {
    display: grid;
    gap: 4px;
  }

  .header-copy strong {
    color: var(--text-1);
    font-size: 16px;
  }

  .header-copy span {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.5;
  }

  .field-card {
    display: grid;
    gap: 16px;
    padding: 18px 20px;
    max-height: calc(90vh - 150px);
    overflow: auto;
  }

  .field-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .field-title {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .field-index {
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  .field-title strong {
    color: var(--text-1);
    font-size: 15px;
    line-height: 1.3;
  }

  .field-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .type-badge,
  .required-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }

  .type-badge {
    background: #eef3ff;
    color: #3156b8;
  }

  .required-badge {
    background: #fff4e8;
    color: #b86a1d;
  }

  .danger-link {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: #fff1f0;
    color: var(--error);
    font-size: 12px;
    font-weight: 600;
  }

  .danger-link:disabled {
    opacity: .45;
    cursor: not-allowed;
  }

  .field-grid {
    display: grid;
    gap: 12px;
  }

  .base-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .rule-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .span-2 {
    grid-column: span 2;
  }

  label,
  .toggle-card {
    display: grid;
    gap: 6px;
  }

  label > span,
  .toggle-card > span {
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
  }

  .toggle-card {
    align-content: start;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--soft);
  }

  .switch-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 22px;
    color: var(--text-1);
    font-size: 13px;
  }

  .switch-row input {
    width: 16px;
    height: 16px;
    margin: 0;
  }

  .constraints {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid #edf1f6;
    border-radius: 12px;
    background: #fafbfd;
  }

  .section-head {
    display: grid;
    gap: 4px;
  }

  .section-head strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .section-head span {
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.5;
  }

  input {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
    background: var(--surface);
  }

  textarea {
    width: 100%;
    min-height: 96px;
    resize: vertical;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
    background: var(--surface);
  }

  input:focus,
  textarea:focus {
    border-color: #8db3ff;
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .12);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px 18px;
    border-top: 1px solid var(--border);
  }

  footer :global(.secondary-btn),
  footer :global(.primary-btn) {
    height: 36px;
    padding: 0 18px;
  }

  .modal-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }

  .hint {
    display: block;
    margin-top: 6px;
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.5;
  }

  @media (max-width: 720px) {
    .field-head,
    footer {
      align-items: stretch;
      flex-direction: column;
    }

    .base-grid,
    .rule-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 560px) {
    .modal header,
    .field-card,
    footer {
      padding-left: 16px;
      padding-right: 16px;
    }

    .base-grid,
    .rule-grid {
      grid-template-columns: 1fr;
    }

    .span-2 {
      grid-column: auto;
    }
  }
</style>
