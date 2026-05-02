<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import type { GridColumnDef } from "../../../../shared/rpc.types";

  const hidden = $derived(new Set(editorStore.viewParams.hiddenFields ?? []));

  let dragKey = $state<string | null>(null);
  let dragOverKey = $state<string | null>(null);
  let menuKey = $state<string | null>(null);

  /** 字段类型 → 列头小图标（text=A 文本、single_select=▾、number/decimal=#、date=日历、checkbox=√）。 */
  function fieldTypeBadge(col: GridColumnDef): { kind: "char"; char: string } | { kind: "icon"; name: string } {
    switch (col.fieldType) {
      case "text":
        return { kind: "char", char: "A" };
      case "single_select":
        return { kind: "icon", name: "chevronDown" };
      case "number":
        return { kind: "char", char: "#" };
      case "decimal":
        return { kind: "char", char: "$" };
      case "date":
        return { kind: "icon", name: "clock" };
      case "checkbox":
        return { kind: "icon", name: "check" };
      default:
        return { kind: "char", char: "?" };
    }
  }

  function toggleVisibility(key: string) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    editorStore.setHiddenFields(Array.from(next));
  }

  function openMenu(key: string, event: MouseEvent) {
    event.stopPropagation();
    menuKey = menuKey === key ? null : key;
  }

  function closeMenu() {
    menuKey = null;
  }

  function editField(key: string) {
    closeMenu();
    editorUi.openFieldEditor(key);
  }

  async function deleteField(key: string) {
    closeMenu();
    if (appState.readOnly) return;
    await editorStore.removeFieldByKey(key);
  }

  async function addField() {
    if (appState.readOnly) return;
    await editorStore.addField();
  }

  function onDragStart(event: DragEvent, key: string) {
    dragKey = key;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    }
  }

  function onDragOver(event: DragEvent, key: string) {
    if (!dragKey || dragKey === key) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOverKey = key;
  }

  async function onDrop(event: DragEvent, targetKey: string) {
    event.preventDefault();
    const src = dragKey;
    dragKey = null;
    dragOverKey = null;
    if (!src || src === targetKey) return;
    const order = editorStore.columns.map((c) => c.key);
    const from = order.indexOf(src);
    const to = order.indexOf(targetKey);
    if (from === -1 || to === -1) return;
    order.splice(from, 1);
    order.splice(to, 0, src);
    await editorStore.reorderFields(order);
  }

  function onDragEnd() {
    dragKey = null;
    dragOverKey = null;
  }
</script>

<div class="field-manager" role="presentation" onmousedown={closeMenu}>
  <header>
    <strong>字段管理</strong>
  </header>

  <div class="list" role="list">
    {#each editorStore.columns as col (col.key)}
      {@const badge = fieldTypeBadge(col)}
      <div
        class="row"
        role="listitem"
        class:dragging={dragKey === col.key}
        class:drag-over={dragOverKey === col.key && dragKey !== col.key}
        draggable={!appState.readOnly}
        ondragstart={(event) => onDragStart(event, col.key)}
        ondragover={(event) => onDragOver(event, col.key)}
        ondrop={(event) => onDrop(event, col.key)}
        ondragend={onDragEnd}
      >
        <span class="grip" aria-hidden="true">
          <span></span><span></span>
          <span></span><span></span>
          <span></span><span></span>
        </span>
        <span class="type-badge">
          {#if badge.kind === "char"}
            <span class="type-char">{badge.char}</span>
          {:else}
            <Icon name={badge.name} size={12} />
          {/if}
        </span>
        <span class="label">{col.label}</span>
        <button
          type="button"
          class="icon-btn visibility"
          class:hidden={hidden.has(col.key)}
          onclick={(event) => { event.stopPropagation(); toggleVisibility(col.key); }}
          aria-label={hidden.has(col.key) ? "显示字段" : "隐藏字段"}
        >
          <Icon name="eye" size={14} />
        </button>
        <button
          type="button"
          class="icon-btn more"
          class:active={menuKey === col.key}
          onclick={(event) => openMenu(col.key, event)}
          aria-label="字段更多操作"
        >
          <Icon name="moreH" size={14} />
        </button>

        {#if menuKey === col.key}
          <div class="row-menu" role="menu" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
            <button class="row-menu-item" role="menuitem" onclick={() => editField(col.key)}>
              编辑
            </button>
            <button
              class="row-menu-item danger"
              role="menuitem"
              onclick={() => deleteField(col.key)}
              disabled={appState.readOnly || editorStore.columns.length <= 1}
            >
              删除
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <button
    type="button"
    class="add-row"
    onclick={addField}
    disabled={appState.readOnly || !editorStore.activeSheetId || editorStore.saving}
  >
    <Icon name="plus" size={14} />
    <span>添加字段</span>
  </button>
</div>

<style>
  .field-manager {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 320px;
    padding: 14px 14px 8px;
  }

  header strong {
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 4px 0 2px;
    border-radius: 8px;
    background: transparent;
    transition: background-color .15s ease;
  }

  .row:hover {
    background: #f5f7fb;
  }

  .row.dragging {
    opacity: .4;
  }

  .row.drag-over {
    background: #eef3ff;
    box-shadow: inset 0 1px 0 var(--primary), inset 0 -1px 0 var(--primary);
  }

  .grip {
    display: grid;
    grid-template-columns: 2px 2px;
    grid-template-rows: 2px 2px 2px;
    gap: 2px;
    width: 10px;
    margin: 0 2px;
    cursor: grab;
    opacity: 0;
    transition: opacity .15s ease;
  }

  .grip span {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: var(--text-3);
  }

  .row:hover .grip {
    opacity: 1;
  }

  .row.dragging .grip,
  .row.drag-over .grip {
    opacity: 1;
  }

  .type-badge {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .type-char {
    font-family: ui-serif, "Times New Roman", serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    color: var(--text-2);
  }

  .label {
    flex: 1;
    min-width: 0;
    color: var(--text-1);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-btn {
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: rgba(15, 23, 42, .06);
    color: var(--text-1);
  }

  .icon-btn.visibility.hidden {
    color: var(--text-3);
    opacity: .35;
  }

  .icon-btn.visibility.hidden:hover {
    opacity: 1;
  }

  .icon-btn.more.active {
    background: rgba(15, 23, 42, .08);
    color: var(--text-1);
  }

  .row-menu {
    position: absolute;
    top: 32px;
    right: 4px;
    z-index: 5;
    display: grid;
    min-width: 96px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 12px 28px rgba(15, 23, 42, .14);
  }

  .row-menu-item {
    display: flex;
    align-items: center;
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .row-menu-item:hover:not(:disabled) {
    background: #f5f7fb;
  }

  .row-menu-item.danger {
    color: var(--error, #e54848);
  }

  .row-menu-item.danger:hover:not(:disabled) {
    background: #fff0f0;
  }

  .row-menu-item:disabled {
    opacity: .45;
    cursor: not-allowed;
  }

  .add-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 6px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    margin-top: 4px;
    border-top: 1px solid var(--border);
    border-radius: 0;
    padding-top: 8px;
    padding-left: 10px;
  }

  .add-row:hover:not(:disabled) {
    color: var(--primary);
  }

  .add-row:disabled {
    opacity: .55;
    cursor: not-allowed;
  }
</style>
