<script lang="ts">
  import { summarizeGridField } from "../../../../shared/field-schema";
  import DatePicker from "../../../components/DatePicker.svelte";
  import SelectMenu from "../../../components/SelectMenu.svelte";
  import type { GridColumnDef } from "../../../../shared/rpc.types";

  let {
    columns,
    values,
    errors = {},
    disabled = false,
    dense = false,
  }: {
    columns: GridColumnDef[];
    values: Record<string, unknown>;
    errors?: Record<string, string>;
    disabled?: boolean;
    dense?: boolean;
  } = $props();

  function updateText(key: string, value: string) {
    values[key] = value;
  }

  function updateNumber(key: string, value: string) {
    values[key] = value === "" ? null : Number(value);
  }

  function updateDate(col: GridColumnDef, next: Date | null) {
    values[col.key] = next;
  }

  function updateCheckbox(key: string, checked: boolean) {
    values[key] = checked;
  }

  function isLongText(col: GridColumnDef) {
    return col.fieldType === "text"
      && ((col.constraints?.maxLength ?? 0) > 120 || /note|desc|remark|memo|备注|说明|描述/.test(`${col.key}${col.label}`));
  }

  function typeLabel(fieldType: string) {
    switch (fieldType) {
      case "text": return "文本";
      case "single_select": return "单选";
      case "number": return "整数";
      case "decimal": return "小数";
      case "date": return "日期";
      case "checkbox": return "勾选";
      default: return fieldType;
    }
  }
</script>

<div class:form-grid={!dense} class:form-stack={dense}>
  {#each columns as col}
    {@const hints = summarizeGridField(col)}
    <label class="field" class:span-all={!dense && isLongText(col)}>
      <span class="field-label">
        <span>
          {col.label}
          {#if col.required}<b>*</b>{/if}
        </span>
        <em>{typeLabel(col.fieldType)}</em>
      </span>

      {#if col.fieldType === "single_select"}
        {#if (col.options?.length ?? 0) > 0 && (col.options?.length ?? 0) <= 5}
          <div class="radio-list" aria-label={col.label}>
            {#each col.options ?? [] as opt}
              <button
                type="button"
                class:active={String(values[col.key] ?? "") === opt}
                disabled={disabled}
                onclick={() => updateText(col.key, opt)}
              >
                <span></span>{opt}
              </button>
            {/each}
          </div>
        {:else}
          <SelectMenu
            value={String(values[col.key] ?? "")}
            disabled={disabled}
            options={[{ value: "", label: "请选择" }, ...(col.options ?? []).map((opt) => ({ value: opt, label: opt }))]}
            ariaLabel={col.label}
            onChange={(next) => updateText(col.key, next)}
          />
        {/if}
      {:else if col.fieldType === "checkbox"}
        <span class="switch-row">
          <input
            type="checkbox"
            checked={Boolean(values[col.key])}
            disabled={disabled}
            onchange={(event) => updateCheckbox(col.key, event.currentTarget.checked)}
          />
          <i>{Boolean(values[col.key]) ? "是" : "否"}</i>
        </span>
      {:else if col.fieldType === "date"}
        <DatePicker
          value={values[col.key] as Date | string | null}
          dateFormat={col.dateFormat}
          minDate={col.constraints?.minDate}
          maxDate={col.constraints?.maxDate}
          disabled={disabled}
          fullWidth
          ariaLabel={col.label}
          onChange={(next) => updateDate(col, next)}
        />
      {:else if col.fieldType === "number" || col.fieldType === "decimal"}
        <input
          type="number"
          value={values[col.key] == null ? "" : String(values[col.key])}
          min={col.constraints?.min}
          max={col.constraints?.max}
          step={col.constraints?.step ?? (col.fieldType === "number" ? 1 : "any")}
          disabled={disabled}
          onchange={(event) => updateNumber(col.key, event.currentTarget.value)}
        />
      {:else if isLongText(col)}
        <textarea
          value={values[col.key] == null ? "" : String(values[col.key])}
          maxlength={col.constraints?.maxLength}
          disabled={disabled}
          rows="5"
          placeholder="待填写人完成"
          oninput={(event) => updateText(col.key, event.currentTarget.value)}
        ></textarea>
      {:else}
        <input
          type="text"
          value={values[col.key] == null ? "" : String(values[col.key])}
          maxlength={col.constraints?.maxLength}
          disabled={disabled}
          placeholder="待填写人完成"
          oninput={(event) => updateText(col.key, event.currentTarget.value)}
        />
      {/if}

      {#if hints.length || errors[col.key]}
        <small class:error={Boolean(errors[col.key])}>
          {#if errors[col.key]}
            {errors[col.key]}
          {:else}
            {hints.join(" / ")}
          {/if}
        </small>
      {/if}
    </label>
  {/each}
</div>

<style>
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 10px;
  }

  .form-stack {
    display: grid;
    gap: 12px;
  }

  .field {
    display: block;
  }

  .span-all {
    grid-column: 1 / -1;
  }

  .field-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 700;
  }

  .field-label em {
    color: var(--text-3);
    font-size: 11px;
    font-style: normal;
    font-weight: 500;
  }

  input,
  textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
    background: #fbfbfc;
    transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
  }

  textarea {
    min-height: 118px;
    resize: vertical;
  }

  input:focus,
  textarea:focus {
    border-color: var(--primary);
    background: var(--surface);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .switch-row {
    display: flex;
    height: 36px;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
  }

  .switch-row input {
    width: 34px;
    height: 20px;
    accent-color: var(--primary);
  }

  .switch-row i {
    color: var(--text-2);
    font-size: 13px;
    font-style: normal;
  }

  .radio-list {
    display: grid;
    gap: 8px;
  }

  .radio-list button {
    display: flex;
    min-height: 34px;
    align-items: center;
    gap: 10px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .radio-list button span {
    width: 18px;
    height: 18px;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: #f7f8fa;
    box-shadow: inset 0 0 0 4px #fff;
  }

  .radio-list button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .radio-list button.active span {
    border-color: var(--primary);
    background: var(--primary);
  }

  small {
    display: block;
    margin-top: 6px;
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.5;
  }

  small.error {
    color: var(--error);
  }

  b {
    color: var(--error);
  }
</style>
