<script lang="ts">
  import { normalizeDateInputValue, summarizeGridField } from "../../../../shared/field-schema";
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

  function updateDate(key: string, value: string) {
    values[key] = value === "" ? null : value;
  }

  function updateCheckbox(key: string, checked: boolean) {
    values[key] = checked;
  }
</script>

<div class:form-grid={!dense} class:form-stack={dense}>
  {#each columns as col}
    {@const hints = summarizeGridField(col)}
    <label class="field">
      <span class="field-label">
        {col.label}
        {#if col.required}<b>*</b>{/if}
      </span>

      {#if col.fieldType === "single_select"}
        <select
          value={String(values[col.key] ?? "")}
          disabled={disabled}
          onchange={(event) => updateText(col.key, event.currentTarget.value)}
        >
          <option value="">请选择</option>
          {#each col.options ?? [] as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      {:else if col.fieldType === "checkbox"}
        <span class="checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(values[col.key])}
            disabled={disabled}
            onchange={(event) => updateCheckbox(col.key, event.currentTarget.checked)}
          />
          <i>启用</i>
        </span>
      {:else if col.fieldType === "date"}
        <input
          type="date"
          value={normalizeDateInputValue(values[col.key])}
          min={col.constraints?.minDate?.slice(0, 10)}
          max={col.constraints?.maxDate?.slice(0, 10)}
          disabled={disabled}
          onchange={(event) => updateDate(col.key, event.currentTarget.value)}
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
      {:else}
        <input
          type="text"
          value={values[col.key] == null ? "" : String(values[col.key])}
          maxlength={col.constraints?.maxLength}
          disabled={disabled}
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

  .field-label {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
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
    background: var(--surface);
  }

  .checkbox-row {
    display: flex;
    height: 36px;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
  }

  .checkbox-row input {
    width: auto;
  }

  .checkbox-row i {
    color: var(--text-2);
    font-size: 13px;
    font-style: normal;
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
