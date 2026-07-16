<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowRight,
    Clock,
    Grid3x3,
    LayoutTemplate,
    Leaf,
    List,
    ListFilter,
    MoreHorizontal,
    Pin,
    Plus,
    Trash2,
    Upload,
    UserPlus,
  } from "@lucide/svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import { workbookTemplatesStore } from "../lib/workbook-templates.svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../lib/permissions.svelte";
  import { getConnectionState, getCurrentUser, getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import { getSurreal } from "../lib/surreal";
  import {
    connectionDotPresentation,
    filterHomeWorkbooks,
    formatWorkbookUpdatedAt,
    homeGreetingForDate,
    loadHomeMemberMetric,
    readWorkbookViewMode,
    workbookCardPresentation,
    writeWorkbookViewMode,
    type WorkbookHomeTab,
    type HomeWorkspaceMetric,
    type WorkbookViewMode,
  } from "../lib/workbook-home";
  import type { WorkbookRow } from "../lib/workbooks";
  import CsvImportDialog from "../components/CsvImportDialog.svelte";
  import XlsxImportDialog from "../components/XlsxImportDialog.svelte";
  import { parseCsvImport, type ParsedCsvImport } from "../lib/csv-import";
  import type { ParsedXlsxImport } from "../lib/xlsx-import";
  import { createXlsxParseTask } from "../lib/xlsx-parse-task";

  // workspace 首页：真实 workbook 列表（直连 SurrealDB）+ quick actions。
  // 跨 workspace 隔离靠 db 边界，列表查询不带鉴权过滤；写权限由 access 类型卡死，
  // 这里的 canWriteSharedStructure 仅做 UI 态。
  let {
    query = "",
    onopen,
    ontemplates,
    onopenaichat,
    onworkspaceclick,
    onpin,
    pinnedIds = [],
  }: {
    query?: string;
    onopen?: (workbookId: string) => void;
    ontemplates?: () => void;
    onopenaichat?: () => void;
    onworkspaceclick?: () => void;
    onpin?: (workbookId: string) => void;
    pinnedIds?: string[];
  } = $props();

  const tabs: Array<{ id: WorkbookHomeTab; label: string }> = [
    { id: "all", label: "全部" },
    { id: "mine", label: "我创建的" },
    { id: "pinned", label: "已固定" },
  ];

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const workspace = $derived(getCurrentWorkspace());
  const currentUser = $derived(getCurrentUser());
  const connectionState = $derived(getConnectionState());
  let tab = $state<WorkbookHomeTab>("all");
  let view = $state<WorkbookViewMode>("grid");
  let sort = $state<"recent" | "name">("recent");
  let creating = $state(false);
  let importStatus = $state("");
  let fileInput = $state<HTMLInputElement>();
  let csvImport = $state<ParsedCsvImport | null>(null);
  let xlsxImport = $state<ParsedXlsxImport | null>(null);
  let xlsxParseTask = $state<ReturnType<typeof createXlsxParseTask> | null>(null);
  let memberMetric = $state<HomeWorkspaceMetric | null>(null);

  const greeting = $derived(homeGreetingForDate());
  const connectionDot = $derived(connectionDotPresentation(connectionState));
  const workspaceName = $derived(workspace?.name || workspace?.slug || workspace?.dbName || "当前工作区");
  const userName = $derived(currentUser?.displayName || currentUser?.name || currentUser?.email || "你");
  const currentUserId = $derived(currentUser?.subject ? `user:${currentUser.subject}` : currentUser?.email);
  const filteredWorkbooks = $derived(
    filterHomeWorkbooks(workbooksStore.workbooks, { query, tab, currentUserId, pinnedIds }),
  );
  const visibleWorkbooks = $derived(
    sort === "name"
      ? [...filteredWorkbooks].sort((a, b) => a.name.localeCompare(b.name, "zh"))
      : filteredWorkbooks,
  );
  const totalCount = $derived(workbooksStore.workbooks.length);

  // templateRef → 模板的解析：类型语义只活在 workbook_template 数据里，这里按引用查回模板，
  // 卡片展示（图标 / 强调色 / 类型名）全部由模板派生，前端不硬编码类型。
  const templateById = $derived(
    new Map(workbookTemplatesStore.templates.map((tpl) => [tpl.id, tpl])),
  );

  function presentationFor(wb: WorkbookRow) {
    const template = wb.templateRef ? templateById.get(wb.templateRef) : undefined;
    return workbookCardPresentation(template);
  }

  onMount(() => {
    view = readWorkbookViewMode(window.localStorage);
    void workbooksStore.load();
    void workbookTemplatesStore.load();
  });

  $effect(() => {
    const metricWorkspace = workspace?.dbName;
    memberMetric = null;
    if (!metricWorkspace || connectionState !== "open") return;

    let active = true;
    void (async () => {
      try {
        const metric = await loadHomeMemberMetric(getSurreal());
        if (active) memberMetric = metric;
      } catch {
        if (active) memberMetric = null;
      }
    })();

    return () => {
      active = false;
    };
  });

  async function handleCreateBlank() {
    if (creating || !canWriteSharedStructure) return;
    creating = true;
    try {
      const wb = await workbooksStore.createBlank("未命名工作簿");
      if (wb) onopen?.(wb.id);
    } finally {
      creating = false;
    }
  }

  function handleImportClick() {
    importStatus = "";
    fileInput?.click();
  }

  async function handleImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.(?:csv|xlsx)$/iu.test(file.name)) {
      importStatus = "请选择 .csv 或 .xlsx 文件";
      return;
    }
    try {
      if (/\.xlsx$/iu.test(file.name)) {
        importStatus = "正在解析 Excel 文件…";
        xlsxParseTask = createXlsxParseTask(file);
        xlsxImport = await xlsxParseTask.promise;
        importStatus = "";
        return;
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      csvImport = parseCsvImport(source, file.name);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        importStatus = "";
        return;
      }
      importStatus = error instanceof TypeError
        ? "文件不是有效的 UTF-8 CSV，请转换编码后重试"
        : (error instanceof Error ? error.message : "文件解析失败");
    } finally {
      xlsxParseTask = null;
    }
  }

  function cancelImportParsing(): void {
    xlsxParseTask?.cancel();
  }

  function open(wb: WorkbookRow) {
    onopen?.(wb.id);
  }

  function setView(next: WorkbookViewMode) {
    view = next;
    writeWorkbookViewMode(window.localStorage, next);
  }

  function pinWorkbook(event: MouseEvent, wb: WorkbookRow) {
    event.stopPropagation();
    onpin?.(wb.id);
  }

  function emptyMessage(): string {
    if (query) return `没有匹配「${query}」的工作簿`;
    if (tab === "pinned") return "还没有已固定的工作簿";
    if (tab === "mine") return "还没有你创建的工作簿";
    return "还没有工作簿，点击上方「空白工作簿」创建第一个";
  }
</script>

<section class="home">
  <div class="content">
    <header class="page-head">
      <div class="head-text">
        <p class="hello">{greeting}，{userName} 👋</p>
        <h1>
          <button type="button" class="workspace-title" onclick={() => onworkspaceclick?.()}>
            {workspaceName}
          </button>
        </h1>
        <div class="stats">
          <span class="stat">
            <span
              class={`conn-dot ${connectionDot.tone}`}
              title={`SurrealDB 连接状态：${connectionDot.label}`}
              aria-label={`SurrealDB 连接状态：${connectionDot.label}`}
            ></span>
            数据库{connectionDot.label}
          </span>
          <span class="divider"></span>
          <span class="stat"><strong>{totalCount}</strong> 个工作簿</span>
          {#if memberMetric}
            <span class="divider"></span>
            <span class="stat"><strong>{memberMetric.value}</strong> {memberMetric.label}</span>
          {/if}
        </div>
      </div>
      <button type="button" class="invite-btn" onclick={() => onworkspaceclick?.()}>
        <UserPlus size={16} />
        邀请协作者
      </button>
    </header>

    {#if !query}
      <div class="quick-actions">
        <button
          type="button"
          class="qa qa-brand"
          onclick={handleCreateBlank}
          disabled={creating || !canWriteSharedStructure}
        >
          <span class="qa-icon"><Plus size={21} /></span>
          <span class="qa-text">
            <strong>{creating ? "创建中…" : "空白工作簿"}</strong>
            <small>{canWriteSharedStructure ? "从零开始搭建数据表" : "需要管理员权限"}</small>
          </span>
        </button>
        <button type="button" class="qa qa-seed" onclick={() => ontemplates?.()} disabled={!canWriteSharedStructure}>
          <span class="qa-icon"><LayoutTemplate size={21} /></span>
          <span class="qa-text">
            <strong>从模板创建</strong>
            <small>案件管理 · 实体追踪</small>
          </span>
        </button>
        <input
          class="file-input"
          bind:this={fileInput}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onchange={(event) => void handleImportFile(event)}
        />
        <button type="button" class="qa qa-neutral" onclick={handleImportClick}>
          <span class="qa-icon"><Upload size={21} /></span>
          <span class="qa-text">
            <strong>导入文件</strong>
            <small>Excel / CSV · 自动识别字段</small>
          </span>
        </button>
      </div>
      {#if importStatus}
        <div class="inline-note">{importStatus}{#if xlsxParseTask}<button type="button" onclick={cancelImportParsing}>取消解析</button>{/if}</div>
      {/if}
    {/if}

    <section class="ai-banner" aria-label="AI 助手">
      <span class="ai-orb"><Leaf size={24} color="#fff" class="ai-leaf" /></span>
      <div class="ai-copy">
        <div class="ai-title">
          <strong>卯豆 AI 助手</strong>
          <span class="ai-beta">BETA</span>
        </div>
        <p>用自然语言查询数据、生成报表、自动整理案件台账——试试「列出本月即将到期的合同」。</p>
      </div>
      <button type="button" class="ai-action" onclick={() => onopenaichat?.()}>
        开始对话
        <ArrowRight size={16} />
      </button>
    </section>

    <section class="workbook-section" aria-label="工作簿">
      <div class="toolbar">
        <div class="section-title">
          <h2>工作簿</h2>
          <span class="count">{visibleWorkbooks.length} 个</span>
        </div>
        <div class="controls">
          <div class="segment" role="tablist" aria-label="工作簿筛选">
            {#each tabs as item}
              <button
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                class:active={tab === item.id}
                onclick={() => (tab = item.id)}
              >
                {item.label}
              </button>
            {/each}
          </div>
          <label class="sort">
            <ListFilter size={14} color="var(--text-3)" />
            <select bind:value={sort} aria-label="排序方式">
              <option value="recent">最近更新</option>
              <option value="name">按名称</option>
            </select>
          </label>
          <div class="segment view-toggle" aria-label="视图切换">
            <button
              type="button"
              class:active={view === "grid"}
              aria-label="网格视图"
              title="网格视图"
              onclick={() => setView("grid")}
            >
              <Grid3x3 size={16} />
            </button>
            <button
              type="button"
              class:active={view === "list"}
              aria-label="列表视图"
              title="列表视图"
              onclick={() => setView("list")}
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>

      {#if workbooksStore.loading}
        <div class="state-msg">加载中…</div>
      {:else if workbooksStore.error}
        <div class="state-msg error">{workbooksStore.error}</div>
      {:else if visibleWorkbooks.length === 0}
        <div class="empty">
          <span class="empty-icon"><LayoutTemplate size={26} color="var(--primary)" /></span>
          <p>{emptyMessage()}</p>
        </div>
      {:else if view === "list"}
        <div class="workbook-table">
          {#each visibleWorkbooks as wb, i (wb.id)}
            {@const presentation = presentationFor(wb)}
            <button
              type="button"
              class="list-row"
              style={`animation-delay:${(0.03 * i).toFixed(2)}s`}
              onclick={() => open(wb)}
            >
              <span class="list-icon" style={`background:${presentation.soft};color:${presentation.accent}`}>
                {#if presentation.previewKind === "graph"}
                  {@render graphMark(presentation.accent)}
                {:else if presentation.previewKind === "blank"}
                  {@render blankMark(presentation.accent)}
                {:else}
                  {@render tableMark(presentation.accent)}
                {/if}
              </span>
              <span class="list-main">
                <span class="list-title-row">
                  <strong>{wb.name}</strong>
                  <span class="tag" style={`color:${presentation.accent};background:${presentation.soft}`}>{presentation.templateLabel}</span>
                </span>
                <small>{presentation.templateLabel}</small>
              </span>
              <span class="list-updated">{formatWorkbookUpdatedAt(wb.updatedAt)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="workbook-grid">
          {#each visibleWorkbooks as wb, i (wb.id)}
            {@const presentation = presentationFor(wb)}
            <article class="workbook-card" style={`animation-delay:${(0.04 * i).toFixed(2)}s`}>
              <button type="button" class="card-main" onclick={() => open(wb)}>
                <div class="card-preview" style={`background:${presentation.soft}`}>
                  <div class="card-grid-bg" style={`background-image:linear-gradient(${presentation.accent} 1px,transparent 1px),linear-gradient(90deg,${presentation.accent} 1px,transparent 1px)`}></div>
                  <span class="card-kind" style={`color:${presentation.accent}`}>
                    {#if presentation.previewKind === "graph"}
                      {@render graphMark(presentation.accent)}
                    {:else if presentation.previewKind === "blank"}
                      {@render blankMark(presentation.accent)}
                    {:else}
                      {@render tableMark(presentation.accent)}
                    {/if}
                  </span>
                </div>
                <div class="card-info">
                  <span class="tag" style={`color:${presentation.accent};background:${presentation.soft}`}>{presentation.templateLabel}</span>
                  <h3 title={wb.name}>{wb.name}</h3>
                  <p class="card-sub">{presentation.templateLabel}</p>
                  <div class="card-footer">
                    <span class="updated"><Clock size={12} />{formatWorkbookUpdatedAt(wb.updatedAt)}</span>
                  </div>
                </div>
              </button>

              <div class="more-menu">
                <button type="button" class="more-trigger" aria-label="更多操作" title="更多操作">
                  <MoreHorizontal size={16} />
                </button>
                <div class="menu-popover" role="menu">
                  <button type="button" role="menuitem" onclick={(event) => pinWorkbook(event, wb)}>
                    <Pin size={14} />
                    <span>固定到侧栏</span>
                  </button>
                  <button type="button" role="menuitem" disabled>
                    <Trash2 size={14} />
                    <span>删除</span>
                  </button>
                </div>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</section>

{#if csvImport}
  <CsvImportDialog
    parsed={csvImport}
    onclose={() => (csvImport = null)}
    onopen={(workbookId) => onopen?.(workbookId)}
  />
{/if}

{#if xlsxImport}
  <XlsxImportDialog
    parsed={xlsxImport}
    onclose={() => (xlsxImport = null)}
    onopen={(workbookId) => onopen?.(workbookId)}
  />
{/if}

{#snippet tableMark(color: string)}
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M4 10h16M4 15h16M10 4v16" />
  </svg>
{/snippet}

{#snippet graphMark(color: string)}
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="8" r="2.4" /><circle cx="12" cy="18" r="2.4" />
    <path d="M7 7l3.5 9M17 9.5 13 16" />
  </svg>
{/snippet}

{#snippet blankMark(color: string)}
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="3" width="14" height="18" rx="2.5" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
{/snippet}

<style>
  .file-input {
    display: none;
  }

  .home {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }

  .content {
    flex: 1;
    overflow: auto;
    padding: 44px 48px 72px;
  }

  .content > * {
    max-width: 1200px;
    margin-left: auto;
    margin-right: auto;
  }

  @keyframes omFadeUp {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes omPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(47, 122, 76, .25); }
    50% { box-shadow: 0 0 0 6px rgba(47, 122, 76, 0); }
  }

  @keyframes omSway {
    0%, 100% { transform: rotate(-3deg); }
    50% { transform: rotate(3deg); }
  }

  /* ---------- header ---------- */
  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 30px;
    animation: omFadeUp .6s cubic-bezier(.2, .7, .2, 1) both;
  }

  .head-text {
    min-width: 0;
  }

  .hello {
    margin: 0 0 10px;
    color: var(--text-3);
    font-size: 13px;
  }

  h1 {
    margin: 0;
  }

  .workspace-title {
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-1);
    font-family: var(--font-serif);
    font-size: 42px;
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -.5px;
    text-align: left;
    cursor: pointer;
  }

  .workspace-title:hover {
    color: var(--primary);
  }

  .stats {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-top: 14px;
    flex-wrap: wrap;
  }

  .stat {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-2);
    font-size: 12.5px;
  }

  .stat strong {
    color: var(--text-1);
    font-weight: 700;
  }

  .divider {
    width: 1px;
    height: 13px;
    background: var(--border-dark);
  }

  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .conn-dot.connected {
    background: var(--primary);
    animation: omPulse 2.4s ease-in-out infinite;
  }

  .conn-dot.disconnected {
    background: var(--error);
  }

  .invite-btn {
    display: inline-flex;
    height: 42px;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border: 1px solid var(--border-dark);
    border-radius: 11px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color .15s ease, box-shadow .15s ease;
  }

  .invite-btn:hover {
    border-color: var(--primary);
    box-shadow: 0 8px 18px -10px rgba(47, 122, 76, .5);
  }

  /* ---------- quick actions ---------- */
  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .qa {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    text-align: left;
    cursor: pointer;
    animation: omFadeUp .55s cubic-bezier(.2, .7, .2, 1) both;
    transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
  }

  .qa:hover:not(:disabled) {
    transform: translateY(-2px);
  }

  .qa-brand:hover:not(:disabled) {
    border-color: var(--brand-mid);
    box-shadow: 0 16px 32px -18px rgba(47, 122, 76, .5);
  }

  .qa-seed:hover:not(:disabled) {
    border-color: #e2a782;
    box-shadow: 0 16px 32px -18px rgba(204, 107, 58, .45);
  }

  .qa-neutral:hover:not(:disabled) {
    border-color: var(--border-dark);
    box-shadow: 0 16px 32px -18px rgba(34, 30, 23, .3);
  }

  .qa:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .qa-icon {
    display: grid;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    place-items: center;
    border-radius: 13px;
  }

  .qa-brand .qa-icon {
    background: var(--primary-light);
    color: var(--primary);
  }

  .qa-seed .qa-icon {
    background: var(--seed-soft);
    color: var(--seed);
  }

  .qa-neutral .qa-icon {
    background: var(--bg);
    color: var(--text-2);
  }

  .qa-text {
    min-width: 0;
  }

  .qa-text strong {
    display: block;
    margin-bottom: 3px;
    color: var(--text-1);
    font-size: 14px;
    font-weight: 700;
  }

  .qa-text small {
    display: block;
    color: var(--text-3);
    font-size: 12px;
  }

  .inline-note {
    margin: 0 0 16px;
    color: var(--text-3);
    font-size: 12px;
  }

  /* ---------- AI banner ---------- */
  .ai-banner {
    position: relative;
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 34px;
    padding: 22px 26px;
    border-radius: 18px;
    background: linear-gradient(105deg, #234e36 0%, #2f7a4c 55%, #3c8f5a 100%);
    overflow: hidden;
    animation: omFadeUp .55s cubic-bezier(.2, .7, .2, 1) both .24s;
  }

  .ai-banner::before,
  .ai-banner::after {
    position: absolute;
    border-radius: 50%;
    content: "";
    pointer-events: none;
  }

  .ai-banner::before {
    right: -40px;
    top: -50px;
    width: 220px;
    height: 220px;
    background: radial-gradient(circle, rgba(255, 255, 255, .14), transparent 70%);
  }

  .ai-banner::after {
    right: 120px;
    bottom: -70px;
    width: 160px;
    height: 160px;
    background: radial-gradient(circle, rgba(141, 212, 154, .25), transparent 70%);
  }

  .ai-orb {
    display: grid;
    width: 50px;
    height: 50px;
    flex-shrink: 0;
    place-items: center;
    border-radius: 15px;
    background: rgba(255, 255, 255, .16);
  }

  .ai-orb :global(.ai-leaf) {
    transform-origin: 50% 100%;
    animation: omSway 4s ease-in-out infinite;
  }

  .ai-copy {
    flex: 1;
    min-width: 0;
    position: relative;
  }

  .ai-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 5px;
  }

  .ai-title strong {
    color: #fff;
    font-size: 15px;
    font-weight: 700;
  }

  .ai-beta {
    padding: 2px 8px;
    border-radius: 99px;
    background: rgba(255, 255, 255, .18);
    color: #eaf6e9;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .6px;
  }

  .ai-copy p {
    margin: 0;
    max-width: 560px;
    color: rgba(255, 255, 255, .82);
    font-size: 13px;
    line-height: 1.5;
  }

  .ai-action {
    position: relative;
    display: inline-flex;
    height: 42px;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    padding: 0 20px;
    border: 0;
    border-radius: 12px;
    background: #fff;
    color: var(--brand-strong);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: transform .15s ease, box-shadow .15s ease;
  }

  .ai-action:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 26px -12px rgba(0, 0, 0, .4);
  }

  /* ---------- workbook section ---------- */
  .workbook-section {
    min-width: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    animation: omFadeUp .5s cubic-bezier(.2, .7, .2, 1) both .3s;
  }

  .section-title {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .section-title h2 {
    margin: 0;
    color: var(--text-1);
    font-family: var(--font-serif);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -.2px;
  }

  .count {
    color: var(--text-3);
    font-size: 13px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .segment {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--bg);
  }

  .segment button {
    display: grid;
    height: 30px;
    place-items: center;
    padding: 0 14px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all .15s ease;
  }

  .segment button.active {
    background: var(--surface);
    color: var(--text-1);
    box-shadow: 0 1px 3px rgba(34, 30, 23, .12);
  }

  .view-toggle button {
    width: 32px;
    padding: 0;
    color: var(--text-3);
  }

  .view-toggle button.active {
    color: var(--text-1);
  }

  .sort {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .sort :global(svg) {
    position: absolute;
    left: 11px;
    pointer-events: none;
  }

  .sort select {
    appearance: none;
    height: 36px;
    padding: 0 30px 0 32px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }

  /* ---------- grid ---------- */
  .workbook-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 18px;
  }

  .workbook-card {
    position: relative;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface);
    overflow: hidden;
    animation: omFadeUp .5s cubic-bezier(.2, .7, .2, 1) both;
    transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
  }

  .workbook-card:hover {
    transform: translateY(-4px);
    border-color: var(--border-dark);
    box-shadow: 0 22px 44px -22px rgba(34, 30, 23, .4);
  }

  .card-main {
    display: flex;
    width: 100%;
    flex-direction: column;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .card-preview {
    position: relative;
    height: 118px;
    overflow: hidden;
  }

  .card-grid-bg {
    position: absolute;
    inset: 0;
    opacity: .5;
    background-size: 26px 26px;
    mask-image: linear-gradient(160deg, #000, transparent 75%);
    -webkit-mask-image: linear-gradient(160deg, #000, transparent 75%);
  }

  .card-kind {
    position: absolute;
    left: 18px;
    top: 18px;
    display: grid;
    width: 42px;
    height: 42px;
    place-items: center;
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 4px 12px -4px rgba(34, 30, 23, .18);
  }

  .card-info {
    display: flex;
    flex-direction: column;
    padding: 16px 18px 14px;
  }

  .tag {
    align-self: flex-start;
    padding: 2px 9px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
  }

  .card-info h3 {
    margin: 9px 0 6px;
    color: var(--text-1);
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-sub {
    margin: 0 0 16px;
    color: var(--text-3);
    font-size: 12px;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .updated {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-3);
    font-size: 11.5px;
  }

  /* ---------- list ---------- */
  .workbook-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    overflow: hidden;
  }

  .list-row {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    padding: 14px 18px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    text-align: left;
    cursor: pointer;
    animation: omFadeUp .5s cubic-bezier(.2, .7, .2, 1) both;
    transition: background .15s ease;
  }

  .list-row:last-child {
    border-bottom: 0;
  }

  .list-row:hover {
    background: var(--bg);
  }

  .list-icon {
    display: grid;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    place-items: center;
    border-radius: 11px;
  }

  .list-main {
    flex: 1;
    min-width: 0;
  }

  .list-title-row {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .list-title-row strong {
    color: var(--text-1);
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-title-row .tag {
    flex-shrink: 0;
    padding: 1px 8px;
    border-radius: 5px;
    font-size: 10.5px;
  }

  .list-main small {
    display: block;
    margin-top: 3px;
    color: var(--text-3);
    font-size: 12px;
  }

  .list-updated {
    width: 96px;
    flex-shrink: 0;
    text-align: right;
    color: var(--text-3);
    font-size: 12px;
  }

  /* ---------- states ---------- */
  .state-msg {
    padding: 48px 0;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .state-msg.error {
    color: var(--error);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 64px 20px;
    border: 1px dashed var(--border-dark);
    border-radius: 18px;
    background: var(--surface);
  }

  .empty-icon {
    display: grid;
    width: 60px;
    height: 60px;
    place-items: center;
    border-radius: 18px;
    background: var(--primary-light);
  }

  .empty p {
    margin: 0;
    color: var(--text-2);
    font-size: 14px;
  }

  /* ---------- more menu ---------- */
  .more-menu {
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 2;
    opacity: 0;
    pointer-events: none;
    transition: opacity .15s ease;
  }

  .workbook-card:hover .more-menu,
  .more-menu:focus-within {
    opacity: 1;
    pointer-events: auto;
  }

  .more-trigger {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(34, 30, 23, .12);
  }

  .menu-popover {
    position: absolute;
    top: 36px;
    right: 0;
    display: none;
    min-width: 144px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 14px 28px rgba(34, 30, 23, .14);
  }

  .more-menu:hover .menu-popover,
  .more-menu:focus-within .menu-popover {
    display: grid;
    gap: 2px;
  }

  .menu-popover button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 9px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .menu-popover button:hover:not(:disabled) {
    background: var(--bg);
    color: var(--text-1);
  }

  .menu-popover button:disabled {
    opacity: .5;
    cursor: not-allowed;
  }
</style>
