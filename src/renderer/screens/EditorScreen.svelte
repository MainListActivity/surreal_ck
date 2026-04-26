<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import Badge from "../components/Badge.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Logo from "../components/Logo.svelte";
  import Grid from "../features/grid/Grid.svelte";
  import { changes, createCreditorRows } from "../lib/mock";
  import type { CreditorRow, Navigate } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();

  const initialRows = createCreditorRows();
  let rows = $state<CreditorRow[]>(initialRows);
  let view = $state<"grid" | "kanban" | "gallery">("grid");
  let panelOpen = $state(false);
  let panelTab = $state("detail");
  let selectedRow = $state<CreditorRow | null>(initialRows[0]);
  let showShare = $state(false);
  let showAdd = $state(false);
  let clipboardStatus = $state("支持从 Excel / WPS / Google Sheets 直接复制 TSV 粘贴");
  let draft = $state<Partial<CreditorRow>>({ type: "普通债权", date: "2026-04-24" });

  const sheets = ["债权申报主表", "关联方列表", "担保物清单"];
  const panelTabs = [
    { id: "detail", label: "详情", icon: "info" },
    { id: "graph", label: "图谱", icon: "network" },
    { id: "changes", label: "最近变更", icon: "history" },
    { id: "review", label: "审核", icon: "review" },
    { id: "ai", label: "AI 助手", icon: "ai" },
  ];

  function openPanel(tab: string) {
    panelTab = tab;
    panelOpen = true;
  }

  function addRecord() {
    if (!draft.name || !draft.amount) return;
    rows = [
      {
        id: rows.length + 1,
        name: draft.name,
        idNo: draft.idNo ?? "",
        contact: draft.contact ?? "",
        amount: draft.amount,
        type: draft.type ?? "普通债权",
        date: draft.date ?? "2026-04-24",
        docs: 0,
        status: "待审核",
        note: draft.note ?? "",
      },
      ...rows,
    ];
    draft = { type: "普通债权", date: "2026-04-24" };
    showAdd = false;
  }
</script>

<section class="editor">
  <header class="doc-topbar">
    <button class="icon-btn" onclick={() => navigate("home")}><Icon name="chevronLeft" size={17} /></button>
    <button class="logo-btn" onclick={() => navigate("home")}><Logo size="sm" /></button>
    <span class="divider"></span>
    <strong class="doc-title">华润置地·破产重整债权申报主表</strong>
    <span class="sync"><Icon name="check" size={13} />已保存</span>
    <span class="divider"></span>
    {#each panelTabs as tab}
      <button class="icon-btn panel-toggle" class:active={panelOpen && panelTab === tab.id} title={tab.label} onclick={() => (panelOpen && panelTab === tab.id ? (panelOpen = false) : openPanel(tab.id))}>
        <Icon name={tab.icon} size={15} />
      </button>
    {/each}
    <button class="primary-btn share" onclick={() => (showShare = true)}><Icon name="share" size={13} color="#fff" />分享</button>
    <div class="avatars"><Avatar name="王晓明" size={28} /><Avatar name="李静" size={28} /></div>
  </header>

  <div class="toolbar">
    <div class="view-tabs">
      {#each [{ id: "grid", label: "表格视图", icon: "grid" }, { id: "kanban", label: "看板视图", icon: "list" }, { id: "gallery", label: "画廊视图", icon: "eye" }] as item}
        <button class:active={view === item.id} onclick={() => (view = item.id as "grid" | "kanban" | "gallery")}><Icon name={item.icon} size={13} />{item.label}</button>
      {/each}
    </div>
    <span class="divider"></span>
    <button class="ghost-btn"><Icon name="filter" size={13} />筛选</button>
    <button class="ghost-btn"><Icon name="sortDesc" size={13} />排序</button>
    <button class="ghost-btn"><Icon name="eye" size={13} />隐藏字段</button>
    <button class="ghost-btn"><Icon name="users" size={13} />分组</button>
    <span class="clipboard-hint">{clipboardStatus}</span>
    <button class="primary-btn compact" onclick={() => (showAdd = true)}><Icon name="plus" size={13} color="#fff" />新增记录</button>
    <button class="secondary-btn compact"><Icon name="upload" size={13} />导入</button>
  </div>

  <div class="body">
    {#if view === "grid"}
      <div class="grid-wrap">
        <Grid bind:rows onRowsChange={(next) => (rows = next)} onFocusRow={(row) => (selectedRow = row)} onClipboardStatus={(msg) => (clipboardStatus = msg)} />
      </div>
    {:else if view === "kanban"}
      <div class="kanban">
        {#each ["待审核", "审核中", "已通过", "已退回"] as status}
          {@const cards = rows.filter((row) => row.status === status).slice(0, 30)}
          <section>
            <h3>{status}<small>({rows.filter((row) => row.status === status).length})</small></h3>
            {#each cards as row}
              <button onclick={() => { selectedRow = row; openPanel("detail"); }}>
                <strong>{row.name}</strong>
                <span>¥ {row.amount}</span>
                <em>{row.type}</em>
              </button>
            {/each}
          </section>
        {/each}
      </div>
    {:else}
      <div class="gallery">
        {#each rows.slice(0, 80) as row}
          <button onclick={() => { selectedRow = row; openPanel("detail"); }}>
            <strong>{row.name}</strong>
            <span>¥ {row.amount}</span>
            <Badge value={row.status} />
            <small>{row.date} · {row.docs} 份附件</small>
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
              <h3>{selectedRow.name}</h3>
              {#each [
                ["证件号码", selectedRow.idNo],
                ["联系方式", selectedRow.contact],
                ["申报金额", `¥ ${selectedRow.amount}`],
                ["债权类型", selectedRow.type],
                ["申报日期", selectedRow.date],
                ["审核状态", selectedRow.status],
                ["备注", selectedRow.note || "—"],
              ] as field}
                <div class="field-row"><span>{field[0]}</span><strong>{field[1]}</strong></div>
              {/each}
              <div class="line"></div>
              <h4>附件（{selectedRow.docs}份）</h4>
              {#each Array.from({ length: Math.min(selectedRow.docs, 5) }) as _, i}
                <div class="attachment"><Icon name="paperclip" size={13} /><span>凭证{i + 1}_{selectedRow.name.slice(0, 4)}.pdf</span><small>{238 + i * 41} KB</small></div>
              {/each}
            {:else}
              <EmptyState icon="info" title="请选择一行" desc="点击表格单元格后在此查看债权人详细信息" />
            {/if}
          {:else if panelTab === "changes"}
            {#each changes as change}
              <div class="change"><Avatar name={change.user} size={26} /><div><strong>{change.user}</strong><span>{change.action}</span><small>{change.time}</small></div></div>
            {/each}
          {:else if panelTab === "graph"}
            <svg class="graph" viewBox="0 0 280 220">
              <line x1="140" y1="110" x2="60" y2="55"></line><line x1="140" y1="110" x2="220" y2="55"></line><line x1="140" y1="110" x2="60" y2="170"></line><line x1="140" y1="110" x2="220" y2="170"></line>
              <circle cx="140" cy="110" r="26"></circle><text x="140" y="108">华润置地</text><text x="140" y="121">债务人</text>
              {#each [[60,55,"债权人"],[220,55,"供应商"],[60,170,"关联方"],[220,170,"担保方"]] as node}
                <circle cx={node[0]} cy={node[1]} r="20"></circle><text x={node[0]} y={node[1]}>{node[2]}</text>
              {/each}
            </svg>
          {:else}
            <EmptyState icon={panelTab === "ai" ? "ai" : "review"} title={panelTab === "ai" ? "AI 助手" : "审核队列"} desc="该功能正在建设中，敬请期待" />
          {/if}
        </div>
      {/if}
    </aside>
  </div>

  <footer class="sheets">
    <button><Icon name="plus" size={14} /></button>
    {#each sheets as sheet, index}
      <button class:active={index === 0}>{sheet}</button>
    {/each}
  </footer>
</section>

{#if showShare}
  <div class="modal-backdrop" role="presentation" onmousedown={() => (showShare = false)}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="分享工作簿" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
      <header><div><strong>分享工作簿</strong><span>华润置地·破产重整债权申报主表</span></div><button class="icon-btn" onclick={() => (showShare = false)}><Icon name="x" size={16} /></button></header>
      <label><span>邀请成员</span><div class="invite"><input placeholder="输入邮箱地址..." /><select><option>可编辑</option><option>可查看</option><option>可评论</option></select><button class="primary-btn">邀请</button></div></label>
      <div class="link-share"><strong>链接分享</strong><label><input type="radio" checked name="perm" />知道链接的人可查看</label><div><span>https://surreal-ck.app/wb/hua-run-2026</span><button>复制链接</button></div></div>
    </div>
  </div>
{/if}

{#if showAdd}
  <div class="modal-backdrop" role="presentation" onmousedown={() => (showAdd = false)}>
    <div class="modal record" role="dialog" aria-modal="true" aria-label="新增记录" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
      <header><strong>新增记录</strong><button class="icon-btn" onclick={() => (showAdd = false)}><Icon name="x" size={16} /></button></header>
      <div class="record-form">
        <label><span>债权人名称<b>*</b></span><input bind:value={draft.name} placeholder="请输入债权人姓名或企业全称" /></label>
        <label><span>证件号码</span><input bind:value={draft.idNo} /></label>
        <label><span>联系方式</span><input bind:value={draft.contact} /></label>
        <label><span>申报金额（元）<b>*</b></span><input bind:value={draft.amount} placeholder="如：100,000.00" /></label>
        <label><span>债权类型</span><select bind:value={draft.type}><option>普通债权</option><option>有担保债权</option><option>职工债权</option><option>工程款债权</option></select></label>
        <label><span>申报日期</span><input type="date" bind:value={draft.date} /></label>
        <label class="wide"><span>备注</span><textarea bind:value={draft.note}></textarea></label>
      </div>
      <footer><button class="secondary-btn" onclick={() => (showAdd = false)}>取消</button><button class="primary-btn" onclick={addRecord}>确认新增</button></footer>
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

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .doc-title {
    min-width: 160px;
    flex: 1;
    overflow: hidden;
    color: var(--text-1);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sync {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--success);
    font-size: 12px;
  }

  .panel-toggle.active {
    background: var(--primary-light);
    color: var(--primary);
  }

  .share {
    padding: 8px 14px;
  }

  .avatars {
    display: flex;
  }

  .avatars :global(.avatar + .avatar) {
    margin-left: -7px;
    border: 2px solid #fff;
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

  .clipboard-hint {
    min-width: 180px;
    flex: 1;
    overflow: hidden;
    color: var(--text-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }

  .compact {
    height: 28px;
    padding: 0 12px;
  }

  .body {
    display: flex;
    min-height: 0;
    flex: 1;
    overflow: hidden;
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
    padding: 16px 20px;
  }

  .kanban section {
    width: 240px;
    flex-shrink: 0;
  }

  .kanban h3 {
    margin: 0 0 10px;
    font-size: 13px;
  }

  .kanban small {
    margin-left: 4px;
    color: var(--text-3);
  }

  .kanban section > button,
  .gallery button {
    width: 100%;
    margin-bottom: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    text-align: left;
  }

  .kanban strong,
  .gallery strong {
    display: block;
    color: var(--text-1);
    font-size: 13px;
  }

  .kanban span,
  .gallery span {
    display: inline-flex;
    margin-top: 6px;
    color: #0070c0;
    font-size: 12px;
    font-weight: 650;
  }

  .kanban em {
    display: inline-flex;
    margin-top: 6px;
    padding: 2px 7px;
    border-radius: 20px;
    background: var(--bg);
    color: var(--text-2);
    font-size: 10px;
    font-style: normal;
  }

  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    align-content: start;
    gap: 12px;
    padding: 20px 24px;
  }

  .gallery small {
    display: block;
    margin-top: 8px;
    color: var(--text-3);
    font-size: 11px;
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

  .panel-content h3 {
    margin: 0 0 14px;
    font-size: 13px;
  }

  .field-row {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    line-height: 1.6;
  }

  .field-row span {
    width: 72px;
    flex-shrink: 0;
    color: var(--text-3);
    font-size: 11px;
  }

  .field-row strong {
    color: var(--text-1);
    font-weight: 500;
    word-break: break-all;
  }

  .line {
    height: 1px;
    margin: 12px 0;
    background: var(--border);
  }

  h4 {
    margin: 0 0 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .attachment {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
    padding: 7px 10px;
    border-radius: 6px;
    background: var(--bg);
    color: var(--text-2);
    font-size: 11px;
  }

  .attachment span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment small,
  .change small {
    color: var(--text-3);
    font-size: 10px;
  }

  .change {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
  }

  .change strong,
  .change span,
  .change small {
    display: block;
  }

  .change strong {
    color: var(--text-1);
    font-size: 12px;
  }

  .change span {
    margin-top: 2px;
    color: var(--text-2);
    font-size: 11px;
    line-height: 1.5;
  }

  .graph {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fafbfc;
  }

  .graph line {
    stroke: var(--border-dark);
    stroke-width: 1.5;
  }

  .graph circle {
    fill: var(--primary-light);
    stroke: var(--primary);
    stroke-width: 1.5;
  }

  .graph text {
    fill: var(--primary);
    font-size: 9px;
    font-weight: 650;
    text-anchor: middle;
    dominant-baseline: middle;
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

  .modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }

  .modal header span {
    display: block;
    margin-top: 2px;
    color: var(--text-3);
    font-size: 11px;
  }

  .modal > label,
  .link-share,
  .record-form {
    display: block;
    margin: 18px 20px;
  }

  .modal label > span,
  .record-form label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
  }

  .invite {
    display: grid;
    grid-template-columns: 1fr 90px 64px;
    gap: 6px;
  }

  input,
  select,
  textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  .link-share {
    padding: 14px;
    border-radius: 10px;
    background: var(--bg);
  }

  .link-share label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0;
    color: var(--text-2);
    font-size: 12px;
  }

  .link-share input {
    width: auto;
  }

  .link-share div {
    display: flex;
    gap: 6px;
  }

  .link-share div span {
    flex: 1;
    overflow: hidden;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-3);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-share div button {
    padding: 8px 14px;
    border: 0;
    border-radius: 7px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
  }

  .record-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 10px;
    max-height: 66vh;
    overflow: auto;
  }

  .record-form label {
    margin: 0;
  }

  .record-form .wide {
    grid-column: 1 / -1;
  }

  textarea {
    min-height: 78px;
    resize: vertical;
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

  .record footer button {
    padding: 8px 20px;
  }
</style>
