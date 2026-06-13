<script lang="ts">
  import { onMount } from "svelte";
  import { Grid3x3, List, MessageCircle, MoreHorizontal, Pin, Plus, Sheet, Sparkles, Tag, Trash2, Upload } from "@lucide/svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../lib/permissions.svelte";
  import { getConnectionState, getCurrentUser, getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import {
    connectionDotPresentation,
    filterHomeWorkbooks,
    formatWorkbookUpdatedAt,
    homeGreetingForDate,
    readWorkbookViewMode,
    workbookCardPresentation,
    writeWorkbookViewMode,
    type WorkbookHomeTab,
    type WorkbookViewMode,
  } from "../lib/workbook-home";
  import type { WorkbookRow } from "../lib/workbooks";

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
  }: {
    query?: string;
    onopen?: (workbookId: string) => void;
    ontemplates?: () => void;
    onopenaichat?: () => void;
    onworkspaceclick?: () => void;
    onpin?: (workbookId: string) => void;
  } = $props();

  const tabs: Array<{ id: WorkbookHomeTab; label: string }> = [
    { id: "all", label: "全部" },
    { id: "mine", label: "我创建的" },
    { id: "shared", label: "与我共享" },
  ];

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  const workspace = $derived(getCurrentWorkspace());
  const currentUser = $derived(getCurrentUser());
  const connectionState = $derived(getConnectionState());
  let tab = $state<WorkbookHomeTab>("all");
  let view = $state<WorkbookViewMode>("grid");
  let creating = $state(false);
  let importStatus = $state("");

  const greeting = $derived(homeGreetingForDate());
  const connectionDot = $derived(connectionDotPresentation(connectionState));
  const workspaceName = $derived(workspace?.name || workspace?.slug || workspace?.dbName || "当前工作区");
  const currentUserId = $derived(currentUser?.subject ? `user:${currentUser.subject}` : currentUser?.email);
  const visibleWorkbooks = $derived(
    filterHomeWorkbooks(workbooksStore.workbooks, { query, tab, currentUserId }),
  );

  onMount(() => {
    view = readWorkbookViewMode(window.localStorage);
    void workbooksStore.load();
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
    importStatus = "导入文件功能尚未迁移，当前版本请先使用空白工作簿或模板创建。";
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

  function collaboratorsFor(wb: WorkbookRow): Array<{ initials: string; tone: string }> {
    const people = [
      { initials: "林", tone: "blue" },
      { initials: "陈", tone: "green" },
      { initials: "周", tone: "amber" },
      { initials: "AI", tone: "purple" },
    ];
    const count = (hashString(wb.id) % people.length) + 1;
    return people.slice(0, count);
  }

  function extraCollaborators(collaborators: Array<unknown>): number {
    return Math.max(0, collaborators.length - 3);
  }

  function emptyMessage(): string {
    if (query) return "没有匹配的工作簿";
    if (tab === "shared") return "共享工作簿会在权限模型接入后显示";
    if (tab === "mine") return "还没有你创建的工作簿";
    return "还没有工作簿，点击上方“空白工作簿”创建第一个";
  }

  function hashString(value: string): number {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash;
  }
</script>

<section class="home">
  <div class="content">
    <section class="greeting">
      <p>{greeting}</p>
      <div class="greeting-title-row">
        <h1>
          <button type="button" class="workspace-title" onclick={() => onworkspaceclick?.()}>
            {workspaceName}
          </button>
        </h1>
        <span
          class={`conn-dot ${connectionDot.tone}`}
          title={`SurrealDB 连接状态：${connectionDot.label}`}
          aria-label={`SurrealDB 连接状态：${connectionDot.label}`}
        ></span>
        <span class="conn-label">{connectionDot.label}</span>
      </div>
    </section>

    <section class="ai-banner" aria-label="AI 能力">
      <div class="ai-banner-copy">
        <span class="ai-banner-icon" aria-hidden="true"><Sparkles size={18} /></span>
        <div>
          <strong>AI 能生成 SurrealQL</strong>
          <p>直接操作数据表结构和数据，把自然语言转成可执行的工作区操作。</p>
        </div>
      </div>
      <button type="button" class="ai-banner-action" onclick={() => onopenaichat?.()}>
        <MessageCircle size={16} />
        <span>开始对话</span>
      </button>
    </section>

    {#if !query}
      <div class="quick-actions">
        <button type="button" onclick={handleCreateBlank} disabled={creating || !canWriteSharedStructure}>
          <span><Plus size={17} color="var(--primary)" /></span>
          <strong>{creating ? "创建中…" : "空白工作簿"}</strong>
          <small>{canWriteSharedStructure ? "从零开始创建" : "需要管理员权限"}</small>
        </button>
        <button type="button" onclick={() => ontemplates?.()} disabled={!canWriteSharedStructure}>
          <span><Tag size={17} color="var(--primary)" /></span>
          <strong>从模板创建</strong>
          <small>案件管理·法律实体追踪</small>
        </button>
        <button type="button" onclick={handleImportClick}>
          <span><Upload size={17} color="var(--primary)" /></span>
          <strong>导入文件</strong>
          <small>敬请期待</small>
        </button>
      </div>
      {#if importStatus}
        <div class="inline-note">{importStatus}</div>
      {/if}
    {/if}

    <section class="workbook-section" aria-label="工作簿">
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="工作簿筛选">
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
        <div class="view-toggle" aria-label="视图切换">
          <button
            type="button"
            class:active={view === "grid"}
            aria-label="网格视图"
            title="网格视图"
            onclick={() => setView("grid")}
          >
            <Grid3x3 size={15} />
          </button>
          <button
            type="button"
            class:active={view === "list"}
            aria-label="列表视图"
            title="列表视图"
            onclick={() => setView("list")}
          >
            <List size={15} />
          </button>
        </div>
      </div>

      {#if workbooksStore.loading}
        <div class="state-msg">加载中…</div>
      {:else if workbooksStore.error}
        <div class="state-msg error">{workbooksStore.error}</div>
      {:else if visibleWorkbooks.length === 0}
        <div class="state-msg">{emptyMessage()}</div>
      {:else if view === "list"}
        <div class="workbook-table">
          <div class="head"><span>名称</span><span>状态</span><span>协作者</span><span>最近修改</span></div>
          {#each visibleWorkbooks as wb (wb.id)}
            {@const presentation = workbookCardPresentation(wb.templateKey)}
            {@const collaborators = collaboratorsFor(wb)}
            <div class="workbook-list-row">
              <button type="button" class="list-main" onclick={() => open(wb)}>
                <span class="list-name">
                  <span class={`list-preview ${presentation.previewKind}`}>
                    <Sheet size={16} />
                  </span>
                  <span>
                    <strong>{wb.name}</strong>
                    <small>{presentation.templateLabel}</small>
                  </span>
                </span>
                <span><em>{presentation.statusLabel}</em></span>
                <span class="avatars" aria-label="协作者">
                  {#each collaborators.slice(0, 3) as person}
                    <span class={`avatar ${person.tone}`}>{person.initials}</span>
                  {/each}
                  {#if extraCollaborators(collaborators)}
                    <span class="avatar more">+{extraCollaborators(collaborators)}</span>
                  {/if}
                </span>
                <span>{formatWorkbookUpdatedAt(wb.updatedAt)}</span>
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="workbook-grid">
          {#each visibleWorkbooks as wb (wb.id)}
            {@const presentation = workbookCardPresentation(wb.templateKey)}
            {@const collaborators = collaboratorsFor(wb)}
            <article class="workbook-card">
              <button type="button" class="card-main" onclick={() => open(wb)}>
                <div class={`workbook-card-preview ${presentation.previewKind}`} aria-hidden="true">
                  {#if presentation.previewKind === "table"}
                    <div class="preview-grid">
                      {#each Array(12) as _, i}
                        <span class:strong={i === 0 || i === 5 || i === 10}></span>
                      {/each}
                    </div>
                  {:else if presentation.previewKind === "graph"}
                    <svg viewBox="0 0 180 92" role="img" aria-label="图谱预览">
                      <line x1="52" y1="44" x2="104" y2="24" />
                      <line x1="52" y1="44" x2="118" y2="68" />
                      <line x1="104" y1="24" x2="118" y2="68" />
                      <circle cx="52" cy="44" r="15" />
                      <circle cx="104" cy="24" r="13" />
                      <circle cx="118" cy="68" r="17" />
                    </svg>
                  {:else}
                    <div class="blank-preview">
                      <span></span>
                      <span></span>
                    </div>
                  {/if}
                </div>

                <div class="card-info">
                  <div class="card-title-row">
                    <strong title={wb.name}>{wb.name}</strong>
                    <em>{presentation.statusLabel}</em>
                  </div>
                  <div class="card-meta">
                    <span>{presentation.templateLabel}</span>
                    <span>{formatWorkbookUpdatedAt(wb.updatedAt)}</span>
                  </div>
                  <div class="card-footer">
                    <span class="avatars" aria-label="协作者">
                      {#each collaborators.slice(0, 3) as person}
                        <span class={`avatar ${person.tone}`}>{person.initials}</span>
                      {/each}
                      {#if extraCollaborators(collaborators)}
                        <span class="avatar more">+{extraCollaborators(collaborators)}</span>
                      {/if}
                    </span>
                    <span class="record-hint">{wb.templateKey ?? "custom"}</span>
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
                    <span>固定到 sidebar</span>
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

<style>
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
    padding: 24px 28px 32px;
  }

  .greeting {
    margin-bottom: 18px;
  }

  .greeting p {
    margin: 0 0 4px;
    color: var(--text-3);
    font-size: 12px;
  }

  .greeting h1 {
    margin: 0;
  }

  .greeting-title-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
  }

  .workspace-title {
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-1);
    font: inherit;
    font-size: 22px;
    font-weight: 720;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
  }

  .workspace-title:hover {
    color: var(--primary);
  }

  .conn-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, .04);
  }

  .conn-dot.connected {
    background: var(--success);
  }

  .conn-dot.disconnected {
    background: var(--error);
  }

  .conn-label {
    color: var(--text-3);
    font-size: 12px;
  }

  .ai-banner {
    display: flex;
    min-height: 96px;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 12px;
    padding: 18px 20px;
    border-radius: 8px;
    background: linear-gradient(135deg, #155eef 0%, #3b82f6 54%, #0f9f8f 100%);
    color: #fff;
    box-shadow: 0 12px 28px rgba(22, 100, 255, .18);
  }

  .ai-banner-copy {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 14px;
  }

  .ai-banner-icon {
    display: grid;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 8px;
    background: rgba(255, 255, 255, .18);
    color: #fff;
  }

  .ai-banner strong {
    display: block;
    color: #fff;
    font-size: 16px;
  }

  .ai-banner p {
    margin: 5px 0 0;
    color: rgba(255, 255, 255, .84);
    font-size: 12px;
    line-height: 1.5;
  }

  .ai-banner-action {
    display: inline-flex;
    height: 34px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 13px;
    border: 0;
    border-radius: 7px;
    background: #fff;
    color: #155eef;
    cursor: pointer;
    font-size: 13px;
    font-weight: 650;
  }

  .ai-banner-action:hover {
    background: #edf4ff;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 20px;
  }

  .quick-actions button,
  .workbook-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    text-align: left;
    transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }

  .quick-actions button {
    display: grid;
    grid-template-columns: 36px 1fr;
    column-gap: 12px;
    padding: 14px 16px;
    cursor: pointer;
  }

  .quick-actions button:hover:not(:disabled),
  .workbook-card:hover {
    border-color: var(--primary);
    box-shadow: 0 8px 22px rgba(22, 100, 255, .10);
  }

  .workbook-card:hover {
    transform: translateY(-1px);
  }

  .quick-actions button:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .quick-actions span {
    display: grid;
    width: 36px;
    height: 36px;
    grid-row: span 2;
    place-items: center;
    border-radius: 8px;
    background: var(--primary-light);
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  small {
    color: var(--text-3);
    font-size: 11px;
  }

  .workbook-section {
    min-width: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }

  .tabs {
    display: flex;
  }

  .tabs button {
    position: relative;
    height: 40px;
    padding: 0 14px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
  }

  .tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .tabs button.active::after {
    position: absolute;
    right: 12px;
    bottom: 0;
    left: 12px;
    height: 2px;
    border-radius: 2px;
    background: var(--primary);
    content: "";
  }

  .view-toggle {
    display: flex;
    gap: 4px;
  }

  .view-toggle button {
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }

  .view-toggle button.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .head,
  .list-main {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) 120px 132px 150px;
    align-items: center;
  }

  .head {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
  }

  .workbook-list-row {
    border-bottom: 1px solid var(--border);
  }

  .list-main {
    width: 100%;
    min-height: 58px;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .list-main:hover {
    background: #f7f9ff;
  }

  .list-name {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 10px;
  }

  .list-name strong,
  .card-title-row strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-name > span:last-child {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .list-preview {
    display: grid;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 8px;
    color: var(--primary);
  }

  .list-preview.table {
    background: var(--primary-light);
  }

  .list-preview.graph {
    background: var(--purple-bg);
    color: var(--purple);
  }

  .list-preview.blank {
    background: var(--soft);
    color: var(--text-3);
  }

  em {
    display: inline-flex;
    width: fit-content;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--primary-light);
    color: var(--primary);
    font-size: 11px;
    font-style: normal;
  }

  .workbook-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 14px;
    padding-top: 14px;
  }

  .workbook-card {
    position: relative;
    min-width: 0;
    overflow: visible;
  }

  .card-main {
    display: grid;
    width: 100%;
    min-height: 246px;
    grid-template-rows: 116px 1fr;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .workbook-card-preview {
    display: grid;
    margin: 12px 12px 0;
    overflow: hidden;
    place-items: center;
    border-radius: 8px;
  }

  .workbook-card-preview.table {
    border: 1px solid #cfe0ff;
    background: linear-gradient(180deg, #f8fbff, #eef5ff);
  }

  .workbook-card-preview.graph {
    border: 1px solid #dfd7ff;
    background: #f7f4ff;
  }

  .workbook-card-preview.blank {
    border: 1px solid var(--border);
    background: linear-gradient(135deg, #f7f8fa, #edf0f5);
  }

  .preview-grid {
    display: grid;
    width: calc(100% - 30px);
    height: 74px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-template-rows: repeat(3, minmax(0, 1fr));
    gap: 5px;
  }

  .preview-grid span {
    border: 1px solid #d9e6ff;
    border-radius: 4px;
    background: rgba(255, 255, 255, .86);
  }

  .preview-grid span.strong {
    background: #dbe9ff;
  }

  .workbook-card-preview svg {
    width: 82%;
    height: 82%;
  }

  .workbook-card-preview line {
    stroke: #a797e9;
    stroke-width: 3;
    stroke-linecap: round;
  }

  .workbook-card-preview circle {
    fill: #fff;
    stroke: var(--purple);
    stroke-width: 4;
  }

  .blank-preview {
    display: grid;
    width: 72%;
    gap: 10px;
  }

  .blank-preview span {
    display: block;
    height: 12px;
    border-radius: 999px;
    background: #dfe3ea;
  }

  .blank-preview span:last-child {
    width: 64%;
  }

  .card-info {
    display: grid;
    gap: 10px;
    padding: 14px 14px 13px;
  }

  .card-title-row,
  .card-meta,
  .card-footer {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .card-title-row strong {
    min-width: 0;
    font-size: 14px;
  }

  .card-meta,
  .record-hint {
    color: var(--text-3);
    font-size: 11px;
  }

  .avatars {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .avatar {
    display: grid;
    width: 24px;
    height: 24px;
    place-items: center;
    border: 2px solid var(--surface);
    border-radius: 50%;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
  }

  .avatar + .avatar {
    margin-left: -7px;
  }

  .avatar.blue {
    background: #2563eb;
  }

  .avatar.green {
    background: #059669;
  }

  .avatar.amber {
    background: #d97706;
  }

  .avatar.purple {
    background: #7c3aed;
  }

  .avatar.more {
    background: var(--text-3);
  }

  .more-menu {
    position: absolute;
    top: 18px;
    right: 18px;
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

  .more-trigger,
  .menu-popover button {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }

  .more-trigger {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border-radius: 7px;
    box-shadow: 0 6px 16px rgba(15, 23, 42, .10);
  }

  .menu-popover {
    position: absolute;
    top: 34px;
    right: 0;
    display: none;
    min-width: 138px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 14px 28px rgba(15, 23, 42, .14);
  }

  .more-menu:hover .menu-popover,
  .more-menu:focus-within .menu-popover {
    display: grid;
    gap: 2px;
  }

  .menu-popover button {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    font-size: 12px;
    text-align: left;
  }

  .menu-popover button:hover:not(:disabled) {
    background: var(--soft);
    color: var(--text-1);
  }

  .menu-popover button:disabled {
    opacity: .5;
    cursor: not-allowed;
  }

  .state-msg {
    padding: 48px 0;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .state-msg.error {
    color: var(--error);
  }

  .inline-note {
    margin: -8px 0 16px;
    color: var(--text-3);
    font-size: 12px;
  }
</style>
