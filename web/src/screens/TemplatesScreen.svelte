<script lang="ts">
  import { onMount } from "svelte";
  import {
    FileQuestion,
    Landmark,
    Network,
    Scale,
    SearchCheck,
    ShieldCheck,
    type Icon as IconType,
  } from "@lucide/svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import {
    workbookTemplatesStore,
    templateColumnDefs,
    templateSheetsForCreate,
  } from "../lib/workbook-templates.svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../lib/permissions.svelte";
  import type { WorkbookTemplate } from "@surreal-ck/shared/rpc.types";

  // 模板选择页：列出 workspace 内 workbook_template 数据行，点选即按模板建工作簿（带类型）。
  // 类型语义全在模板数据里——本页不硬编码任何行业类型，只渲染数据 + 触发 createFromTemplate。
  let {
    onopen,
    onback,
  }: {
    onopen?: (workbookId: string) => void;
    onback?: () => void;
  } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());
  let creatingKey = $state<string | null>(null);
  let includeSampleData = $state(true);
  let createError = $state("");

  // 模板 icon 名（lucide kebab-case，存在数据里）→ 组件。未知图标回退通用图标。
  const ICONS: Record<string, typeof IconType> = {
    scale: Scale,
    network: Network,
    "shield-check": ShieldCheck,
    "search-check": SearchCheck,
    landmark: Landmark,
  };

  function iconFor(name: string | undefined): typeof IconType {
    return (name && ICONS[name]) || FileQuestion;
  }

  onMount(() => {
    void workbookTemplatesStore.load();
  });

  async function createFrom(template: WorkbookTemplate) {
    if (creatingKey || !canWriteSharedStructure) return;
    creatingKey = template.key;
    createError = "";
    try {
      const sheets = templateSheetsForCreate(template);
      const columns = templateColumnDefs(template);
      const wb = await workbooksStore.createFromTemplate({
        id: template.id,
        defaultName: template.defaultName,
        sheets: sheets.length ? sheets : undefined,
        columns: sheets.length ? undefined : columns,
        defaultDashboard: template.defaultDashboard,
      }, undefined, { includeSampleData });
      if (wb) onopen?.(wb.id);
      else createError = workbooksStore.error ?? "模板创建失败，请稍后重试";
    } finally {
      creatingKey = null;
    }
  }
</script>

<section class="templates">
  <div class="content">
    <header class="head">
      <div>
        <h1>从模板创建</h1>
        <p>选择一个业务模板，快速生成带预设结构的工作簿。模板由工作区维护，可由管理员增删。</p>
      </div>
      <button type="button" class="back" onclick={() => onback?.()}>返回首页</button>
    </header>

    <fieldset class="sample-choice" disabled={!!creatingKey || !canWriteSharedStructure}>
      <legend>初始数据</legend>
      <label>
        <input type="radio" name="sample-data" value={true} bind:group={includeSampleData} />
        <span><strong>包含样例数据</strong><small>推荐用于演示，可立即查看完整台账效果</small></span>
      </label>
      <label>
        <input type="radio" name="sample-data" value={false} bind:group={includeSampleData} />
        <span><strong>创建空台账</strong><small>只创建数据表和字段结构</small></span>
      </label>
    </fieldset>

    {#if createError}<div class="state error" role="alert">{createError}</div>{/if}

    {#if workbookTemplatesStore.loading}
      <div class="state">加载模板中…</div>
    {:else if workbookTemplatesStore.error}
      <div class="state error">{workbookTemplatesStore.error}</div>
    {:else if workbookTemplatesStore.templates.length === 0}
      <div class="state">当前工作区还没有模板。管理员可在数据库中新增 workbook_template 数据行。</div>
    {:else}
      <div class="grid">
        {#each workbookTemplatesStore.templates as tpl (tpl.id)}
          {@const Ico = iconFor(tpl.icon)}
          <button
            type="button"
            class="card"
            onclick={() => createFrom(tpl)}
            disabled={!!creatingKey || !canWriteSharedStructure}
          >
            <span class="badge" style={`background:${tpl.accent ?? "#8C8472"}1A;color:${tpl.accent ?? "#6F6859"}`}>
              <Ico size={22} />
            </span>
            <strong>{tpl.label}</strong>
            {#if tpl.description}<small>{tpl.description}</small>{/if}
            <span class="action">{creatingKey === tpl.key ? "创建中…" : (canWriteSharedStructure ? "使用此模板" : "需要管理员权限")}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .templates {
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
    max-width: 1100px;
    margin-left: auto;
    margin-right: auto;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 30px;
  }

  h1 {
    margin: 0 0 8px;
    color: var(--text-1);
    font-family: var(--font-serif);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -.3px;
  }

  .head p {
    margin: 0;
    max-width: 560px;
    color: var(--text-2);
    font-size: 13.5px;
    line-height: 1.55;
  }

  .back {
    flex-shrink: 0;
    height: 38px;
    padding: 0 16px;
    border: 1px solid var(--border-dark);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .back:hover {
    border-color: var(--primary);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }

  .sample-choice {
    display: flex;
    align-items: stretch;
    gap: 12px;
    margin: 0 0 24px;
    padding: 0;
    border: 0;
  }

  .sample-choice legend {
    margin-bottom: 9px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 700;
  }

  .sample-choice label {
    display: flex;
    flex: 1;
    gap: 10px;
    padding: 13px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    cursor: pointer;
  }

  .sample-choice label:has(input:checked) {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }

  .sample-choice input {
    margin: 3px 0 0;
    accent-color: var(--primary);
  }

  .sample-choice span {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .sample-choice strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .sample-choice small {
    color: var(--text-3);
    font-size: 11.5px;
    font-weight: 400;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    text-align: left;
    cursor: pointer;
    transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
  }

  .card:hover:not(:disabled) {
    transform: translateY(-3px);
    border-color: var(--border-dark);
    box-shadow: 0 18px 36px -20px rgba(34, 30, 23, .4);
  }

  .card:disabled {
    opacity: .6;
    cursor: not-allowed;
  }

  .badge {
    display: grid;
    width: 46px;
    height: 46px;
    place-items: center;
    border-radius: 13px;
  }

  .card strong {
    color: var(--text-1);
    font-size: 15px;
    font-weight: 700;
  }

  .card small {
    color: var(--text-3);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .action {
    margin-top: 6px;
    color: var(--primary);
    font-size: 12.5px;
    font-weight: 600;
  }

  .state {
    padding: 56px 0;
    color: var(--text-3);
    font-size: 13.5px;
    text-align: center;
  }

  .state.error {
    color: var(--error);
  }
</style>
