<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import SelectMenu from "../../../components/SelectMenu.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import type { FilterClause, FilterOp, GridColumnDef } from "../../../../shared/rpc.types";

  type FilterDraft = FilterClause & { id: number };

  let nextId = 0;
  let drafts = $state<FilterDraft[]>(
    (editorStore.viewParams.filters ?? []).map((f) => ({ ...f, id: nextId++ })),
  );
  let mode = $state<"and" | "or">(editorStore.viewParams.filterMode ?? "and");

  const opOptions: Array<{ op: FilterOp; label: string }> = [
    { op: "eq", label: "等于" },
    { op: "neq", label: "不等于" },
    { op: "gt", label: "大于" },
    { op: "gte", label: "大于等于" },
    { op: "lt", label: "小于" },
    { op: "lte", label: "小于等于" },
    { op: "contains", label: "包含" },
    { op: "not_contains", label: "不包含" },
    { op: "in", label: "在 (多值)" },
    { op: "is_null", label: "为空" },
    { op: "is_not_null", label: "不为空" },
  ];

  const fieldOptions = $derived(editorStore.columns.map((col) => ({ value: col.key, label: col.label })));
  const filterOpOptions = opOptions.map((opt) => ({ value: opt.op, label: opt.label }));

  function defaultKey(): string {
    return editorStore.columns[0]?.key ?? "";
  }

  function addClause() {
    drafts = [...drafts, { id: nextId++, key: defaultKey(), op: "eq", value: "" }];
  }

  function removeClause(id: number) {
    drafts = drafts.filter((d) => d.id !== id);
  }

  function needValue(op: FilterOp): "scalar" | "array" | "none" {
    if (op === "is_null" || op === "is_not_null") return "none";
    if (op === "in") return "array";
    return "scalar";
  }

  function inputTypeFor(col: GridColumnDef | undefined): string {
    if (!col) return "text";
    if (col.fieldType === "number" || col.fieldType === "decimal") return "number";
    if (col.fieldType === "date") return "date";
    return "text";
  }

  async function apply() {
    const cleaned: FilterClause[] = drafts
      .filter((d) => editorStore.columns.some((c) => c.key === d.key))
      .map(({ id: _id, ...rest }) => {
        if (rest.op === "in" && typeof rest.value === "string") {
          return { ...rest, value: rest.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) };
        }
        return rest;
      });
    await editorStore.setFilters(cleaned, mode);
  }

  async function clearAll() {
    drafts = [];
    await editorStore.setFilters([], mode);
  }
</script>

<div class="tool-panel">
  <header>
    <strong>筛选</strong>
    <div class="mode">
      <label><input type="radio" bind:group={mode} value="and" />并且</label>
      <label><input type="radio" bind:group={mode} value="or" />或者</label>
    </div>
  </header>

  {#if drafts.length === 0}
    <p class="hint">未添加筛选条件，所有记录都会显示</p>
  {/if}

  {#each drafts as draft (draft.id)}
    {@const col = editorStore.columns.find((c) => c.key === draft.key)}
    {@const valueKind = needValue(draft.op)}
    <div class="row">
      <SelectMenu
        compact
        value={draft.key}
        options={fieldOptions}
        ariaLabel="筛选字段"
        onChange={(next) => (draft.key = next)}
      />
      <SelectMenu
        compact
        value={draft.op}
        options={filterOpOptions}
        ariaLabel="筛选条件"
        onChange={(next) => (draft.op = next as FilterOp)}
      />
      {#if valueKind === "scalar"}
        {#if col?.fieldType === "single_select"}
          <SelectMenu
            compact
            value={String(draft.value ?? "")}
            options={[{ value: "", label: "—" }, ...(col.options ?? []).map((opt) => ({ value: opt, label: opt }))]}
            ariaLabel="筛选值"
            onChange={(next) => (draft.value = next)}
          />
        {:else if col?.fieldType === "checkbox"}
          <SelectMenu
            compact
            value={String(draft.value ?? "true")}
            options={[{ value: "true", label: "是" }, { value: "false", label: "否" }]}
            ariaLabel="勾选值"
            onChange={(next) => (draft.value = next)}
          />
        {:else}
          <input type={inputTypeFor(col)} bind:value={draft.value} placeholder="值" />
        {/if}
      {:else if valueKind === "array"}
        <input type="text" bind:value={draft.value} placeholder="多个值，逗号或换行分隔" />
      {:else}
        <span class="placeholder">—</span>
      {/if}
      <button class="icon-btn" onclick={() => removeClause(draft.id)} title="删除">
        <Icon name="x" size={12} />
      </button>
    </div>
  {/each}

  <footer>
    <button class="ghost-btn" onclick={addClause}>
      <Icon name="plus" size={12} />添加条件
    </button>
    <div class="spacer"></div>
    {#if drafts.length > 0}
      <button class="ghost-btn" onclick={clearAll}>清空</button>
    {/if}
    <button class="primary-btn" onclick={apply} disabled={editorStore.loading}>应用</button>
  </footer>
</div>

<style>
  .tool-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-1);
    font-size: 12px;
    font-weight: 600;
  }

  .mode {
    display: flex;
    gap: 10px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 400;
  }

  .mode label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .hint {
    margin: 0;
    color: var(--text-3);
    font-size: 11px;
  }

  .row {
    display: grid;
    grid-template-columns: 140px 130px 1fr 24px;
    align-items: center;
    gap: 8px;
  }

  input {
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    outline: none;
  }

  .placeholder {
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }

  .icon-btn {
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-3);
  }

  .icon-btn:hover {
    background: var(--bg);
    color: var(--text-1);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px dashed var(--border);
    margin-top: 4px;
    padding-top: 10px;
  }

  .spacer {
    flex: 1;
  }

  .ghost-btn {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .primary-btn {
    height: 26px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
  }

  .primary-btn:disabled {
    opacity: 0.5;
  }
</style>
