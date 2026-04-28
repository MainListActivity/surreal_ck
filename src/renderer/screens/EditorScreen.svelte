<script lang="ts">
  import { onMount } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Logo from "../components/Logo.svelte";
  import { appState } from "../lib/app-state.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import type { Navigate } from "../lib/types";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import { onDestroy } from "svelte";
  import type { GridColumnDef } from "../../shared/rpc.types";

  let { navigate, workbookId }: { navigate: Navigate; workbookId?: string } = $props();

  let view = $state<"grid" | "kanban" | "gallery">("grid");
  let panelOpen = $state(false);
  let panelTab = $state("detail");
  let clipboardStatus = $state("支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴");
  let showAdd = $state(false);
  let showFields = $state(false);
  let showShare = $state(false);
  let showMenu = $state(false);
  let activeTool = $state<string | null>(null);
  let draft = $state<Record<string, string>>({});
  let titleDraft = $state("");
  let titleFocused = $state(false);
  let fieldDrafts = $state<Array<GridColumnDef & { optionsText?: string }>>([]);
  let selectedRowId = $state<string | null>(null);

  const panelTabs = [
    { id: "detail", label: "详情", icon: "info" },
    { id: "changes", label: "最近变更", icon: "history" },
    { id: "ai", label: "AI 助手", icon: "ai" },
  ];
  const toolbarActions = [
    { id: "filter", label: "筛选", icon: "filter" },
    { id: "sort", label: "排序", icon: "sortDesc" },
    { id: "hidden", label: "隐藏字段", icon: "eye" },
    { id: "group", label: "分组", icon: "users" },
  ];
  const quickMembers = ["王晓明", "李静"];

  $effect(() => {
    if (workbookId) {
      void editorStore.loadWorkbook(workbookId);
    } else {
      editorStore.reset();
    }
  });

  $effect(() => {
    if (!titleFocused) titleDraft = editorStore.workbookName;
  });

  // 将 GridRow[] 转为 RevoGrid source 格式
  const gridSource = $derived(
    editorStore.rows.map((row) => ({ _id: row.id, ...row.values }))
  );

  // 将 GridColumnDef[] 映射为 RevoGrid columns
  const gridColumns = $derived<ColumnRegular[]>(
    editorStore.columns.map((col) => ({
      prop: col.key,
      name: col.label,
      size: 160,
    }))
  );

  const selectedRow = $derived(
    selectedRowId ? editorStore.rows.find((r) => r.id === selectedRowId) ?? null : null
  );
  const titleColumn = $derived(editorStore.columns[0] ?? null);
  const secondaryColumn = $derived(editorStore.columns[1] ?? null);
  const statusColumn = $derived(editorStore.columns.find((col) => /status|状态/i.test(col.key) || /状态/.test(col.label)) ?? editorStore.columns.find((col) => col.options?.length));
  const amountColumn = $derived(editorStore.columns.find((col) => col.fieldType === "number" || col.fieldType === "decimal") ?? null);
  const dateColumn = $derived(editorStore.columns.find((col) => col.fieldType === "date") ?? null);
  const selectedCount = $derived(selectedRowId ? 1 : 0);

  let gridRef = $state<{
    getWebComponent: () => HTMLElement & {
      getFocused?: () => Promise<{ y?: number } | undefined>;
      getSource?: () => Promise<Array<Record<string, unknown>>>;
    };
  } | null>(null);

  let gridCleanup: (() => void) | undefined;

  onMount(() => {
    const grid = gridRef?.getWebComponent();
    const handleGlobalPointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".menu-wrap")) return;
      showMenu = false;
      activeTool = null;
    };

    document.addEventListener("mousedown", handleGlobalPointer);
    if (!grid) {
      return () => document.removeEventListener("mousedown", handleGlobalPointer);
    }

    const beforePaste = (event: Event) => {
      const detail = (event as CustomEvent<{ parsed?: unknown[][] }>).detail;
      const parsed = detail?.parsed;
      if (parsed?.length) {
        clipboardStatus = `检测到粘贴：${parsed.length} 行 × ${parsed[0]?.length ?? 0} 列`;
      }
    };

    const afterPaste = async () => {
      if (appState.readOnly) {
        clipboardStatus = "离线模式，粘贴未保存";
        return;
      }
      clipboardStatus = "粘贴已应用，保存中…";
      const next = await grid.getSource?.();
      if (next?.length) {
        await editorStore.saveFromSource(next);
        clipboardStatus = editorStore.saveError ? `保存失败: ${editorStore.saveError}` : "已保存";
      }
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    gridCleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
      document.removeEventListener("mousedown", handleGlobalPointer);
    };
  });

  onDestroy(() => gridCleanup?.());

  async function handleAfterEdit() {
    if (appState.readOnly) return;
    const next = await gridRef?.getWebComponent()?.getSource?.();
    if (next?.length) {
      await editorStore.saveFromSource(next);
    }
  }

  async function handleFocus() {
    const grid = gridRef?.getWebComponent();
    const focused = await grid?.getFocused?.();
    const rowIndex = focused?.y;
    selectedRowId = typeof rowIndex === "number" ? (editorStore.rows[rowIndex]?.id ?? null) : null;
  }

  async function addRecord() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    const values: Record<string, unknown> = {};
    for (const col of editorStore.columns) {
      values[col.key] = draft[col.key] ?? "";
    }
    await editorStore.saveRows([{ values }]);
    draft = {};
    showAdd = false;
  }

  async function saveTitle() {
    titleFocused = false;
    const next = titleDraft.trim();
    if (!next || next === editorStore.workbookName || appState.readOnly) {
      titleDraft = editorStore.workbookName;
      return;
    }
    const ok = await editorStore.renameWorkbook(next);
    if (!ok) titleDraft = editorStore.workbookName;
  }

  function handleTitleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      (event.currentTarget as HTMLInputElement).blur();
    } else if (event.key === "Escape") {
      titleDraft = editorStore.workbookName;
      (event.currentTarget as HTMLInputElement).blur();
    }
  }

  function openFields() {
    fieldDrafts = editorStore.columns.map((col) => ({
      ...col,
      optionsText: col.options?.join("\n") ?? "",
    }));
    showFields = true;
  }

  function addFieldDraft() {
    const used = new Set(fieldDrafts.map((field) => field.key));
    let i = fieldDrafts.length + 1;
    while (used.has(`field_${i}`)) i++;
    fieldDrafts = [
      ...fieldDrafts,
      { key: `field_${i}`, label: "新字段", fieldType: "text", required: false, optionsText: "" },
    ];
  }

  function removeFieldDraft(index: number) {
    fieldDrafts = fieldDrafts.filter((_, i) => i !== index);
  }

  async function saveFields() {
    if (appState.readOnly) return;
    const columns = fieldDrafts.map(({ optionsText, ...field }) => ({
      ...field,
      options: field.fieldType === "single_select"
        ? (optionsText ?? "").split("\n").map((opt) => opt.trim()).filter(Boolean)
        : undefined,
    }));
    const ok = await editorStore.updateFields(columns);
    if (ok) showFields = false;
  }

  function openPanel(tab: string) {
    panelTab = tab;
    panelOpen = true;
  }

  function toggleTool(toolId: string) {
    activeTool = activeTool === toolId ? null : toolId;
  }

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    showMenu = !showMenu;
  }

  function openShare(event?: MouseEvent) {
    event?.stopPropagation();
    showShare = true;
  }

  function statusTone(value: unknown): string {
    const text = String(value ?? "");
    if (/(通过|完成|已完成|active|open)/i.test(text)) return "success";
    if (/(审核中|处理中|pending)/i.test(text)) return "info";
    if (/(退回|拒绝|失败|closed|error)/i.test(text)) return "error";
    return "warning";
  }

  function cardAccent(value: unknown): string {
    return `var(--${statusTone(value)})`;
  }

  function cardPillStyle(value: unknown): string {
    const tone = statusTone(value);
    const bg = `var(--${tone}-bg)`;
    const fg = `var(--${tone})`;
    return `--pill-bg:${bg};--pill-color:${fg}`;
  }
</script>

<section class="editor">
  <header class="doc-topbar">
    <button class="icon-btn" onclick={() => navigate("home")}><Icon name="chevronLeft" size={17} /></button>
    <button class="logo-btn" onclick={() => navigate("home")}><Logo size="sm" /></button>
    <span class="divider"></span>
    <strong class="doc-title">
      {#if editorStore.loading}加载中…
      {:else if editorStore.error}加载失败
      {:else}
        <input
          value={titleDraft}
          readonly={appState.readOnly}
          aria-label="工作簿名称"
          oninput={(event) => (titleDraft = event.currentTarget.value)}
          onfocus={() => (titleFocused = true)}
          onblur={saveTitle}
          onkeydown={handleTitleKeydown}
        />
      {/if}
    </strong>
    <span class="sync" class:error={Boolean(editorStore.saveError)} class:warning={appState.readOnly}>
      {#if editorStore.saving}
        <Icon name="refresh" size={13} />保存中…
      {:else if editorStore.saveError}
        <Icon name="alertCircle" size={13} />保存失败
      {:else if appState.readOnly}
        <Icon name="wifiOff" size={13} />只读
      {:else}
        <Icon name="check" size={13} />已保存
      {/if}
    </span>
    <span class="divider"></span>
    {#each panelTabs as tab}
      <button class="icon-btn panel-toggle" class:active={panelOpen && panelTab === tab.id} title={tab.label} onclick={() => (panelOpen && panelTab === tab.id ? (panelOpen = false) : openPanel(tab.id))}>
        <Icon name={tab.icon} size={15} />
      </button>
    {/each}
    <span class="divider"></span>
    <button class="share-btn" onclick={openShare}>
      <Icon name="share" size={13} color="#fff" />分享
    </button>
    <div class="member-stack">
      {#each quickMembers as member}
        <Avatar name={member} size={28} />
      {/each}
    </div>
    <div class="menu-wrap">
      <button class="icon-btn" onclick={toggleMenu} title="更多操作"><Icon name="moreH" size={16} /></button>
      {#if showMenu}
        <div class="menu-pop">
          {#each ["导出为 Excel", "打印", "复制链接", "版本历史", "删除工作簿"] as item, index}
            <button class:index-danger={index === 4} onclick={() => (showMenu = false)}>{item}</button>
          {/each}
        </div>
      {/if}
    </div>
  </header>

  <div class="toolbar">
    <div class="view-tabs">
      {#each [{ id: "grid", label: "表格视图", icon: "grid" }, { id: "kanban", label: "看板视图", icon: "list" }, { id: "gallery", label: "画廊视图", icon: "eye" }] as item}
        <button class:active={view === item.id} onclick={() => (view = item.id as "grid" | "kanban" | "gallery")}><Icon name={item.icon} size={13} />{item.label}</button>
      {/each}
    </div>
    <span class="divider"></span>
    {#each toolbarActions as action}
      <button class="tool-btn" class:active={activeTool === action.id} onclick={(event) => { event.stopPropagation(); toggleTool(action.id); }}>
        <Icon name={action.icon} size={13} />{action.label}
      </button>
    {/each}
    <div class="toolbar-fill"></div>
    {#if selectedCount > 0}
      <span class="selected-hint">已选 {selectedCount} 条</span>
    {/if}
    <button class="compact ghost-btn" onclick={openFields} disabled={appState.readOnly || !editorStore.activeSheetId}>
      <Icon name="settings" size={13} />字段
    </button>
    <button
      class="primary-btn compact"
      onclick={() => (showAdd = true)}
      disabled={appState.readOnly || !editorStore.activeSheetId}
    >
      <Icon name="plus" size={13} color="#fff" />新增记录
    </button>
    <button class="compact ghost-btn" disabled={appState.readOnly}>
      <Icon name="upload" size={13} />导入
    </button>
  </div>

  {#if activeTool}
    <div class="toolbar-note">{clipboardStatus}</div>
  {/if}

  <div class="body">
    {#if editorStore.loading}
      <div class="body-state">加载工作簿数据…</div>
    {:else if editorStore.error}
      <div class="body-state error">{editorStore.error}</div>
    {:else if !editorStore.activeSheetId}
      <div class="body-state">
        <EmptyState icon="grid" title="无数据" desc="工作簿不包含任何 Sheet" />
      </div>
    {:else if view === "grid"}
      <div class="grid-wrap">
        <RevoGrid
          bind:this={gridRef}
          source={gridSource}
          columns={gridColumns}
          theme="compact"
          rowHeaders={true}
          range={true}
          resize={true}
          useClipboard={true}
          canFocus={true}
          rowSize={36}
          frameSize={35}
          stretch="none"
          hideAttribution={true}
          readonly={appState.readOnly}
          style="height: 100%; width: 100%;"
          on:afterfocus={handleFocus}
          on:afteredit={handleAfterEdit}
        />
      </div>
    {:else if view === "kanban"}
      <div class="kanban">
        {#each Array.from(new Set(editorStore.rows.map((row) => String(statusColumn ? row.values[statusColumn.key] ?? "未分类" : "全部")))).slice(0, 4) as status}
          <section class="kanban-col">
            <header>
              <span class="dot" style={`background:${cardAccent(status)}`}></span>
              <strong>{status}</strong>
              <span>({editorStore.rows.filter((row) => String(statusColumn ? row.values[statusColumn.key] ?? "未分类" : "全部") === status).length})</span>
            </header>
            <div class="kanban-list">
              {#each editorStore.rows.filter((row) => String(statusColumn ? row.values[statusColumn.key] ?? "未分类" : "全部") === status).slice(0, 40) as row}
                <button class="kanban-card" onclick={() => { selectedRowId = row.id; openPanel("detail"); }}>
                  <strong>{String(titleColumn ? row.values[titleColumn.key] ?? "—" : row.id)}</strong>
                  {#if amountColumn}
                    <span class="money">¥ {String(row.values[amountColumn.key] ?? "0")}</span>
                  {/if}
                  <div class="kanban-meta">
                    {#if secondaryColumn}<span>{String(row.values[secondaryColumn.key] ?? "")}</span>{/if}
                    {#if dateColumn}<span>{String(row.values[dateColumn.key] ?? "")}</span>{/if}
                  </div>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {:else}
      <div class="gallery">
        {#each editorStore.rows.slice(0, 80) as row}
          <button class="gallery-card" onclick={() => { selectedRowId = row.id; openPanel("detail"); }}>
            <span class="gallery-strip" style={`background:${cardAccent(statusColumn ? row.values[statusColumn.key] : "")}`}></span>
            <strong>{String(titleColumn ? row.values[titleColumn.key] ?? "—" : row.id)}</strong>
            {#if amountColumn}
              <span class="money">¥ {String(row.values[amountColumn.key] ?? "0")}</span>
            {/if}
            <div class="gallery-tags">
              {#if statusColumn}
                <span class="pill" style={cardPillStyle(row.values[statusColumn.key])}>{String(row.values[statusColumn.key] ?? "未分类")}</span>
              {/if}
              {#if secondaryColumn}
                <span>{String(row.values[secondaryColumn.key] ?? "")}</span>
              {/if}
            </div>
            {#if dateColumn}
              <small>{String(row.values[dateColumn.key] ?? "")}</small>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <aside class:open={panelOpen} class="right-panel">
      {#if panelOpen}
        <div class="panel-tabs">
          {#each panelTabs as tab}
            <button class:active={panelTab === tab.id} onclick={() => (panelTab = tab.id)}>{tab.label}</button>
          {/each}
          <button class="close" onclick={() => (panelOpen = false)}><Icon name="x" size={14} /></button>
        </div>
        <div class="panel-content">
          {#if panelTab === "detail"}
            {#if selectedRow}
              <div class="panel-hero">
                <strong>{String(titleColumn ? selectedRow.values[titleColumn.key] ?? "—" : selectedRow.id)}</strong>
                {#if statusColumn}
                  <span class="pill" style={cardPillStyle(selectedRow.values[statusColumn.key])}>{String(selectedRow.values[statusColumn.key] ?? "未分类")}</span>
                {/if}
              </div>
              {#each editorStore.columns as col}
                <div class="field-row">
                  <span>{col.label}</span>
                  <strong>{String(selectedRow.values[col.key] ?? "—")}</strong>
                </div>
              {/each}
            {:else}
              <EmptyState icon="info" title="请选择一行" desc="点击表格单元格后在此查看详情" />
            {/if}
          {:else}
            <EmptyState icon={panelTab === "ai" ? "ai" : "history"} title={panelTab === "ai" ? "AI 助手" : "最近变更"} desc="该功能正在建设中，敬请期待" />
          {/if}
        </div>
      {/if}
    </aside>
  </div>

  <footer class="sheets">
    <button title="新增 Sheet" disabled><Icon name="plus" size={14} /></button>
    {#each editorStore.sheets as sheet}
      <button
        class:active={editorStore.activeSheetId === sheet.id}
        onclick={() => void editorStore.switchSheet(sheet.id)}
      >
        {sheet.label}
      </button>
    {/each}
  </footer>
</section>

{#if showAdd}
  <div class="modal-backdrop" role="presentation" onmousedown={() => (showAdd = false)}>
    <div class="modal record" role="dialog" aria-modal="true" aria-label="新增记录" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
      <header><strong>新增记录</strong><button class="icon-btn" onclick={() => (showAdd = false)}><Icon name="x" size={16} /></button></header>
      <div class="record-form">
        {#each editorStore.columns as col}
          <label>
            <span>{col.label}{#if col.required}<b>*</b>{/if}</span>
            {#if col.options?.length}
              <select bind:value={draft[col.key]}>
                <option value="">请选择</option>
                {#each col.options as opt}<option>{opt}</option>{/each}
              </select>
            {:else}
              <input bind:value={draft[col.key]} placeholder={col.label} />
            {/if}
          </label>
        {/each}
      </div>
      <footer>
        <button class="secondary-btn" onclick={() => (showAdd = false)}>取消</button>
        <button class="primary-btn" onclick={addRecord}>确认新增</button>
      </footer>
    </div>
  </div>
{/if}

{#if showFields}
  <div class="modal-backdrop" role="presentation" onmousedown={() => (showFields = false)}>
    <div class="modal fields" role="dialog" aria-modal="true" aria-label="字段设置" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
      <header><strong>字段设置</strong><button class="icon-btn" onclick={() => (showFields = false)}><Icon name="x" size={16} /></button></header>
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
            {#if field.fieldType === "single_select"}
              <label class="options-row">
                <span>选项，每行一个</span>
                <textarea bind:value={field.optionsText} rows="3"></textarea>
              </label>
            {/if}
            <button class="icon-btn danger" title="删除字段" onclick={() => removeFieldDraft(index)} disabled={fieldDrafts.length <= 1}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        {/each}
      </div>
      <footer>
        {#if editorStore.saveError}<span class="modal-error">{editorStore.saveError}</span>{/if}
        <button class="secondary-btn" onclick={addFieldDraft}><Icon name="plus" size={13} />新增字段</button>
        <button class="primary-btn" onclick={saveFields} disabled={editorStore.saving}>保存字段</button>
      </footer>
    </div>
  </div>
{/if}

{#if showShare}
  <div class="modal-backdrop" role="presentation" onmousedown={() => (showShare = false)}>
    <div class="modal share" role="dialog" aria-modal="true" aria-label="分享工作簿" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
      <header><strong>分享工作簿</strong><button class="icon-btn" onclick={() => (showShare = false)}><Icon name="x" size={16} /></button></header>
      <div class="share-body">
        <label>
          <span>链接权限</span>
          <select>
            <option>工作区成员可编辑</option>
            <option>工作区成员只读</option>
            <option>仅指定成员可访问</option>
          </select>
        </label>
        <label>
          <span>共享链接</span>
          <div class="share-link">
            <input value={`surreal_ck://workbook/${workbookId ?? ""}`} readonly />
            <button class="secondary-btn">复制链接</button>
          </div>
        </label>
      </div>
      <footer>
        <button class="secondary-btn" onclick={() => (showShare = false)}>关闭</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .editor {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
  }

  .doc-topbar,
  .toolbar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .doc-topbar {
    height: 48px;
    gap: 8px;
    padding: 0 12px;
  }

  .logo-btn {
    display: flex;
    align-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 4px 6px;
    cursor: pointer;
  }

  .logo-btn:hover {
    background: var(--bg);
  }

  .toolbar {
    height: 40px;
    gap: 2px;
    padding: 0 12px;
  }

  .toolbar-note {
    display: flex;
    height: 28px;
    align-items: center;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: #f7f8fa;
    color: var(--text-3);
    font-size: 11px;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .doc-title {
    display: flex;
    align-items: center;
    min-width: 160px;
    flex: 1;
    overflow: hidden;
    color: var(--text-1);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .doc-title input {
    height: 30px;
    width: min(520px, 100%);
    border-color: transparent;
    background: transparent;
    padding: 4px 7px;
    font-weight: 650;
  }

  .doc-title input:hover,
  .doc-title input:focus {
    border-color: var(--border);
    background: var(--bg);
  }

  .sync {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--success);
    font-size: 12px;
  }

  .sync.warning {
    color: var(--warning);
  }

  .sync.error {
    color: var(--error);
  }

  .panel-toggle.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .share-btn {
    display: inline-flex;
    height: 30px;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    border: 0;
    border-radius: 7px;
    background: var(--primary);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .member-stack {
    display: flex;
    margin-left: 2px;
  }

  .member-stack :global(.avatar) {
    margin-left: -6px;
    border: 2px solid #fff;
  }

  .menu-wrap {
    position: relative;
  }

  .menu-pop {
    position: absolute;
    top: 36px;
    right: 0;
    z-index: 30;
    min-width: 156px;
    padding: 4px 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
  }

  .menu-pop button {
    width: 100%;
    padding: 8px 16px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }

  .menu-pop button:hover {
    background: var(--bg);
  }

  .menu-pop button.index-danger {
    color: var(--error);
  }

  .view-tabs {
    display: flex;
    align-self: stretch;
  }

  .view-tabs button,
  .toolbar > button {
    display: flex;
    height: 28px;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
  }

  .tool-btn.active {
    border: 1px solid var(--primary);
    background: var(--primary-light);
    color: var(--primary);
  }

  .ghost-btn {
    border: 1px solid var(--border) !important;
    background: var(--surface) !important;
  }

  .toolbar-fill {
    flex: 1;
  }

  .selected-hint {
    margin-right: 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .view-tabs button {
    position: relative;
    height: 40px;
    border-radius: 0;
  }

  .view-tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .view-tabs button.active::after {
    position: absolute;
    right: 10px;
    bottom: 0;
    left: 10px;
    height: 2px;
    background: var(--primary);
    content: "";
  }

  .compact {
    height: 28px;
    padding: 0 12px;
  }

  .compact:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .body {
    display: flex;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .body-state {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 13px;
  }

  .body-state.error {
    color: var(--error);
  }

  .grid-wrap {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    background: #fafbfc;
  }

  .kanban,
  .gallery {
    flex: 1;
    overflow: auto;
    background: var(--bg);
  }

  .kanban {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 16px 20px;
  }

  .kanban-col {
    width: 240px;
    flex-shrink: 0;
  }

  .kanban-col header {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 10px;
  }

  .kanban-col header strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .kanban-col header span:last-child {
    color: var(--text-3);
    font-size: 11px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .kanban-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .kanban-card {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    text-align: left;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .05);
  }

  .kanban-card:hover,
  .gallery-card:hover {
    box-shadow: 0 8px 24px rgba(0, 0, 0, .1);
    transform: translateY(-1px);
  }

  .kanban-card strong,
  .gallery-card strong {
    display: block;
    margin-bottom: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
  }

  .money {
    display: block;
    margin-bottom: 8px;
    color: #0070c0 !important;
    font-size: 12px !important;
    font-weight: 600;
  }

  .kanban-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--text-3);
    font-size: 11px;
  }

  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    align-content: start;
    gap: 12px;
    padding: 20px 24px;
  }

  .gallery-card {
    position: relative;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    text-align: left;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .05);
    transition: box-shadow .15s ease, transform .15s ease;
  }

  .gallery-strip {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 4px;
  }

  .gallery-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .gallery span {
    display: inline-flex;
    color: var(--text-2);
    font-size: 12px;
  }

  .gallery small {
    display: block;
    margin-top: 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 20px;
    background: var(--pill-bg, var(--bg));
    color: var(--pill-color, var(--text-3));
    font-size: 10px;
    font-weight: 600;
  }

  .right-panel {
    width: 0;
    flex-shrink: 0;
    overflow: hidden;
    border-left: 0;
    background: var(--surface);
    transition: width .2s ease;
  }

  .right-panel.open {
    width: 320px;
    border-left: 1px solid var(--border);
  }

  .panel-tabs {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }

  .panel-tabs button {
    height: 42px;
    padding: 0 9px;
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
  }

  .panel-tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .panel-tabs .close {
    margin-left: auto;
  }

  .panel-content {
    height: calc(100% - 43px);
    overflow: auto;
    padding: 14px 16px;
  }

  .panel-hero {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .panel-hero strong {
    color: var(--text-1);
    font-size: 14px;
    font-weight: 700;
  }

  .field-row {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    line-height: 1.6;
  }

  .field-row span {
    width: 80px;
    flex-shrink: 0;
    color: var(--text-3);
    font-size: 11px;
  }

  .field-row strong {
    color: var(--text-1);
    font-weight: 500;
    word-break: break-all;
  }

  .sheets {
    display: flex;
    height: 36px;
    flex-shrink: 0;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
    border-top: 1px solid var(--border);
    background: var(--soft);
  }

  .sheets button {
    height: 28px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px 6px 0 0;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
  }

  .sheets button.active {
    border-bottom: 2px solid var(--primary);
    background: var(--surface);
    color: var(--primary);
    font-weight: 650;
  }

  .sheets button:disabled {
    opacity: .4;
    cursor: not-allowed;
  }

  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .modal {
    width: min(480px, calc(100vw - 32px));
    max-height: 90vh;
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
  }

  .share {
    width: min(540px, calc(100vw - 32px));
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

  .record-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 10px;
    max-height: 66vh;
    overflow: auto;
    margin: 18px 20px;
  }

  .share-body {
    display: grid;
    gap: 16px;
    padding: 18px 20px;
  }

  .share-body label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
  }

  .share-link {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
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
    grid-template-columns: minmax(130px, 1.2fr) minmax(120px, 1fr) 128px 76px 32px;
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

  .danger {
    color: var(--error);
  }

  .record-form label {
    display: block;
  }

  .record-form label > span {
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
  }

  b {
    color: var(--error);
  }

  .record footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  .fields footer,
  .share footer {
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

  .record footer button {
    padding: 8px 20px;
  }

  :global(revo-grid) {
    --revo-grid-font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    --revo-grid-primary: var(--primary);
    --revo-grid-cell-border: var(--border);
    --revo-grid-header-border: var(--border);
    --revo-grid-row-hover: #f7f9ff;
    --revo-grid-focused-bg: #edf2ff;
    --revo-grid-header-bg: #f7f8fa;
    --revo-grid-text: var(--text-2);
    border: 0;
  }

  :global(revo-grid .rgCell),
  :global(revo-grid .rgHeaderCell) {
    font-size: 12px;
  }
</style>
