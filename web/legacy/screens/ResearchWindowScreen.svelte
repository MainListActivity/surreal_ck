<script lang="ts">
  import { onMount } from "svelte";
  import type { ResearchSessionDTO, ResourceDetailResponse, ResourceEvidenceDTO } from "../../shared/rpc.types";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import { canRetryResourceEmbedding, formatStructuredPayload, resourceDetailSourceLabel } from "../lib/resource-detail-state";
  import { addEvidenceSnippet, removeEvidenceSnippet } from "../lib/research-evidence";
  import Icon from "../components/Icon.svelte";
  import {
    DEFAULT_RESEARCH_SEARCH_ENGINE,
    RESEARCH_SEARCH_ENGINES,
    normalizeResearchVisitUrl,
    resolveResearchNavigation,
    type ResearchSearchEngineId,
  } from "../../shared/research-url";

  let {
    sessionId,
    initialResourceType = "generic_note",
    initialUrl = "",
  }: {
    sessionId?: string;
    initialResourceType?: string;
    initialUrl?: string;
  } = $props();

  let session = $state<ResearchSessionDTO | null>(null);
  let urlInput = $state("");
  let activeUrl = $state("");
  let error = $state<string | null>(null);
  let externalFrame = $state<HTMLIFrameElement | null>(null);
  let evidence = $state<ResourceEvidenceDTO[]>([]);
  let pasteOpen = $state(false);
  let pasteText = $state("");
  let draftTitle = $state("");
  let draftSummary = $state("");
  let generatingDraft = $state(false);
  let savingResource = $state(false);
  let savedResourceIds = $state<string[]>([]);
  let resourceType = $state("generic_note");
  let detail = $state<ResourceDetailResponse | null>(null);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);
  let retryingEmbedding = $state(false);
  let searchEngine = $state<ResearchSearchEngineId>(DEFAULT_RESEARCH_SEARCH_ENGINE);

  onMount(() => {
    resourceType = initialResourceType;
    urlInput = initialUrl;
    activeUrl = normalizeResearchVisitUrl(initialUrl) ?? "";
    void loadSession();
  });

  function closeDetailFromBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) closeResourceDetail();
  }

  async function loadSession() {
    if (!sessionId) return;
    const res = await appApi.getResearchSession({ sessionId });
    if (!res.ok) {
      error = res.message;
      return;
    }
    session = res.data.session;
    resourceType = session.resourceType;
  }

  function navigateExternal() {
    const target = resolveResearchNavigation(urlInput, searchEngine);
    if (!target) {
      error = "请输入域名、URL 或搜索关键词。";
      return;
    }
    error = null;
    activeUrl = target.url;
  }

  function sourceTitleForActiveUrl(): string | undefined {
    if (!activeUrl) return undefined;
    try {
      return new URL(activeUrl).hostname;
    } catch {
      return undefined;
    }
  }

  function sourceUrlForResource(): string | undefined {
    return evidence[0]?.sourceUrl ?? (normalizeResearchVisitUrl(activeUrl) ? activeUrl : undefined);
  }

  function sourceTitleForResource(): string | undefined {
    return evidence[0]?.sourceTitle ?? sourceTitleForActiveUrl();
  }

  function structuredPayloadForResource(): Record<string, unknown> {
    if (resourceType !== "web_article") return {};
    const siteName = sourceTitleForResource();
    return siteName ? { siteName } : {};
  }

  function readExternalSelection(): string {
    try {
      return externalFrame?.contentWindow?.getSelection()?.toString().trim() ?? "";
    } catch {
      return "";
    }
  }

  function appendEvidence(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    evidence = addEvidenceSnippet(evidence, {
      text: trimmed,
      sourceUrl: activeUrl || undefined,
      sourceTitle: sourceTitleForActiveUrl(),
      capturedAt: new Date().toISOString(),
    });
    pasteText = "";
    pasteOpen = false;
  }

  function captureEvidence() {
    const selectedText = readExternalSelection();
    if (selectedText) appendEvidence(selectedText);
    else pasteOpen = true;
  }

  async function generateDraft() {
    const workspaceId = session?.workspaceId ?? appState.workspace?.id;
    if (!workspaceId || !evidence.length) return;
    generatingDraft = true;
    error = null;
    try {
      const res = await appApi.generateResourceDraft({
        workspaceId,
        resourceType,
        evidence,
        title: draftTitle,
        summary: draftSummary,
      });
      if (!res.ok) {
        error = res.message;
        return;
      }
      draftTitle = res.data.draft.title;
      draftSummary = res.data.draft.summary;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      generatingDraft = false;
    }
  }

  async function saveCurrentResource() {
    const workspaceId = session?.workspaceId ?? appState.workspace?.id;
    if (!workspaceId || !draftTitle.trim() || !draftSummary.trim()) return;
    savingResource = true;
    error = null;
    try {
      const res = sessionId
        ? await appApi.saveResearchResource({
            sessionId,
            resourceType,
            title: draftTitle,
            summary: draftSummary,
            sourceUrl: sourceUrlForResource(),
            sourceTitle: sourceTitleForResource(),
            evidence,
            structuredPayload: structuredPayloadForResource(),
            quality: "user-confirmed",
          })
        : await appApi.saveResource({
            workspaceId,
            resourceType,
            title: draftTitle,
            summary: draftSummary,
            sourceUrl: sourceUrlForResource(),
            sourceTitle: sourceTitleForResource(),
            evidence,
            structuredPayload: structuredPayloadForResource(),
            quality: "user-confirmed",
          });
      if (!res.ok) {
        error = res.message;
        return;
      }
      savedResourceIds = [...savedResourceIds, res.data.resource.id];
      evidence = [];
      draftTitle = "";
      draftSummary = "";
      await openResourceDetail(res.data.resource.id);
      await loadSession();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      savingResource = false;
    }
  }

  async function finishResearch() {
    if (!session || !sessionId || !savedResourceIds.length) return;
    const res = await appApi.completeResearchSession({ sessionId, resourceIds: savedResourceIds });
    if (!res.ok) {
      error = res.message;
      return;
    }
    session = res.data.session;
    if (session.originatingRunId) {
      await appApi.resumeAiWorkflow(session.originatingRunId, {
        kind: "manual-research-completed",
        resourceIds: res.data.session.resourceIds,
      });
    }
  }

  async function openResourceDetail(resourceId: string) {
    detailLoading = true;
    detailError = null;
    try {
      const res = await appApi.getResourceDetail({ resourceId });
      if (!res.ok) {
        detailError = res.message;
        return;
      }
      detail = res.data;
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    } finally {
      detailLoading = false;
    }
  }

  async function retryDetailEmbedding() {
    const resourceId = detail?.resource.id;
    if (!resourceId) return;
    retryingEmbedding = true;
    detailError = null;
    try {
      const res = await appApi.retryResourceEmbedding(resourceId);
      if (!res.ok) {
        detailError = res.message;
        return;
      }
      detail = {
        ...detail,
        resource: {
          ...detail.resource,
          embedding: res.data.embedding,
        },
      };
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    } finally {
      retryingEmbedding = false;
    }
  }

  function closeResourceDetail() {
    detail = null;
    detailError = null;
    detailLoading = false;
    retryingEmbedding = false;
  }
</script>

<main class="research-shell">
  <section class="trusted-panel">
    <div class="trusted-title">
      <Icon name="search" size={16} />
      <strong>资源检索</strong>
    </div>
    {#if session}
      <dl>
        <div>
          <dt>问题</dt>
          <dd>{session.query}</dd>
        </div>
        <div>
          <dt>类型</dt>
          <dd>{session.resourceType}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{session.status}</dd>
        </div>
      </dl>
    {/if}
    {#if !session}
      <label class="resource-type-select">
        <span>类型</span>
        <select bind:value={resourceType}>
          <option value="generic_note">generic_note</option>
          <option value="web_article">web_article</option>
        </select>
      </label>
    {/if}
    <div class="url-bar">
      <select class="engine-select" bind:value={searchEngine} aria-label="搜索引擎">
        {#each RESEARCH_SEARCH_ENGINES as engine}
          <option value={engine.id}>{engine.label}</option>
        {/each}
      </select>
      <input bind:value={urlInput} placeholder="URL、域名或搜索词" onkeydown={(event) => { if (event.key === "Enter") navigateExternal(); }} />
      <button onclick={navigateExternal}>打开</button>
    </div>
    {#if error}<p class="error">{error}</p>{/if}

    <div class="evidence-actions">
      <button class="secondary" disabled={!activeUrl} onclick={captureEvidence}>加入证据</button>
      <button class="secondary" disabled={!evidence.length || generatingDraft} onclick={() => { void generateDraft(); }}>
        {generatingDraft ? "生成中" : "生成草稿"}
      </button>
    </div>

    {#if pasteOpen}
      <div class="paste-box">
        <textarea bind:value={pasteText} placeholder="粘贴证据文本"></textarea>
        <div>
          <button class="secondary" onclick={() => appendEvidence(pasteText)}>加入</button>
          <button class="ghost" onclick={() => { pasteOpen = false; pasteText = ""; }}>取消</button>
        </div>
      </div>
    {/if}

    <div class="evidence-list">
      {#each evidence as item (item.order)}
        <article>
          <p>{item.text}</p>
          <small>{item.sourceTitle ?? item.sourceUrl ?? "手动证据"}</small>
          <button class="ghost" onclick={() => { evidence = removeEvidenceSnippet(evidence, item.order); }}>删除</button>
        </article>
      {/each}
    </div>

    <div class="draft-fields">
      <input bind:value={draftTitle} placeholder="资源标题" />
      <textarea bind:value={draftSummary} placeholder="资源摘要"></textarea>
    </div>

    <div class="evidence-actions">
      <button class="secondary" disabled={savingResource || !draftTitle.trim() || !draftSummary.trim()} onclick={() => { void saveCurrentResource(); }}>
        {savingResource ? "保存中" : "保存资源"}
      </button>
      <button class="secondary" disabled={!savedResourceIds.length || session?.status !== "open"} onclick={() => { void finishResearch(); }}>完成检索</button>
    </div>
    {#if savedResourceIds.length}
      <div class="saved-resources">
        <p class="saved-count">已保存 {savedResourceIds.length} 个资源</p>
        {#each savedResourceIds as resourceId}
          <button class="saved-resource-btn" onclick={() => { void openResourceDetail(resourceId); }}>
            <Icon name="eye" size={13} />
            查看 {resourceId}
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="external-pane">
    {#if activeUrl}
      <iframe
        bind:this={externalFrame}
        title="外部检索页面"
        src={activeUrl}
        sandbox="allow-forms allow-scripts allow-popups allow-top-navigation-by-user-activation"
      ></iframe>
    {:else}
      <div class="search-portal">
        <div class="portal-mark">
          <Icon name="search" size={28} />
          <strong>资源检索</strong>
        </div>
        <form class="portal-url" onsubmit={(event) => { event.preventDefault(); navigateExternal(); }}>
          <select class="engine-select" bind:value={searchEngine} aria-label="搜索引擎">
            {#each RESEARCH_SEARCH_ENGINES as engine}
              <option value={engine.id}>{engine.label}</option>
            {/each}
          </select>
          <input bind:value={urlInput} placeholder="输入 URL、域名或搜索词" />
          <button>打开</button>
        </form>
        <span>从可信窗口收集证据并保存为工作区资源</span>
      </div>
    {/if}
  </section>

  {#if detail || detailLoading || detailError}
    <div class="detail-backdrop" role="presentation" onclick={closeDetailFromBackdrop}>
      <div class="resource-detail-dialog" role="dialog" aria-modal="true" aria-label="资源详情" tabindex="-1">
        <header>
          <div>
            <strong>资源详情</strong>
            {#if detail?.resource}
              <span>{detail.resource.resourceType} · {detail.resource.quality}</span>
            {/if}
          </div>
          <button class="ghost detail-close" aria-label="关闭资源详情" onclick={closeResourceDetail}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {#if detailLoading}
          <p class="detail-muted">正在读取资源详情</p>
        {:else if detail?.resource}
          <div class="detail-body">
            <section>
              <h2>{detail.resource.title}</h2>
              <p>{detail.resource.summary}</p>
            </section>

            <section>
              <h3>来源</h3>
              {#if detail.resource.sourceUrl}
                <a href={detail.resource.sourceUrl} target="_blank" rel="noreferrer">{resourceDetailSourceLabel(detail.resource)}</a>
              {:else}
                <p>{resourceDetailSourceLabel(detail.resource)}</p>
              {/if}
            </section>

            <section>
              <h3>证据</h3>
              <div class="detail-evidence">
                {#each detail.resource.evidence as item (item.order)}
                  <article>
                    <p>{item.text}</p>
                    <small>{item.sourceTitle ?? item.sourceUrl ?? "手动证据"}</small>
                  </article>
                {/each}
              </div>
            </section>

            <section>
              <h3>Structured Payload</h3>
              <pre>{formatStructuredPayload(detail.resource.structuredPayload)}</pre>
            </section>

            <section>
              <h3>Embedding</h3>
              <div class="embedding-state">
                <span>{detail.resource.embedding.status}</span>
                {#if detail.resource.embedding.errorSummary}
                  <small>{detail.resource.embedding.errorSummary}</small>
                {/if}
                {#if canRetryResourceEmbedding(detail.resource.embedding.status)}
                  <button class="secondary" disabled={retryingEmbedding} onclick={() => { void retryDetailEmbedding(); }}>
                    <Icon name="refresh" size={13} />
                    {retryingEmbedding ? "重试中" : "重试索引"}
                  </button>
                {/if}
              </div>
            </section>
          </div>
        {/if}

        {#if detailError}<p class="error">{detailError}</p>{/if}
      </div>
    </div>
  {/if}
</main>

<style>
  .research-shell {
    position: relative;
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    background: var(--bg);
  }

  .trusted-panel {
    display: grid;
    align-content: start;
    gap: 16px;
    padding: 18px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .trusted-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
  }

  dl {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  dt {
    color: var(--text-3);
    font-size: 11px;
  }

  dd {
    margin: 2px 0 0;
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .url-bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
  }

  input {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
  }

  select {
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    font-size: 12px;
  }

  .engine-select {
    width: 82px;
    color: var(--text-2);
  }

  .resource-type-select {
    display: grid;
    gap: 6px;
    color: var(--text-3);
    font-size: 11px;
  }

  button {
    height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
  }

  button.secondary,
  button.ghost {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-1);
  }

  button.ghost {
    color: var(--text-3);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  textarea {
    width: 100%;
    min-height: 70px;
    padding: 8px 10px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
  }

  .evidence-actions,
  .paste-box div {
    display: flex;
    gap: 8px;
  }

  .paste-box,
  .evidence-list,
  .draft-fields {
    display: grid;
    gap: 8px;
  }

  .evidence-list article {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--soft);
  }

  .evidence-list p {
    margin: 0;
    color: var(--text-1);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .evidence-list small {
    color: var(--text-3);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .saved-count {
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
  }

  .saved-resources {
    display: grid;
    gap: 8px;
  }

  .saved-resource-btn,
  .embedding-state button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .error {
    margin: 0;
    color: #b42318;
    font-size: 12px;
  }

  .external-pane {
    min-width: 0;
    min-height: 0;
    background: #fff;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  .search-portal {
    height: 100%;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 20px;
    padding: 32px;
    color: var(--text-3);
    font-size: 13px;
    background:
      radial-gradient(circle at 50% 38%, rgba(22, 100, 255, .07), transparent 280px),
      #fff;
  }

  .portal-mark {
    display: grid;
    justify-items: center;
    gap: 12px;
    color: var(--primary);
  }

  .portal-mark strong {
    color: var(--text-1);
    font-size: 24px;
    font-weight: 650;
    letter-spacing: 0;
  }

  .portal-url {
    width: min(680px, 100%);
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 7px 8px 7px 16px;
    border: 1px solid rgba(203, 213, 225, .9);
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 10px 32px rgba(15, 23, 42, .12);
  }

  .portal-url input {
    height: 38px;
    border: 0;
    padding: 0;
    font-size: 15px;
    outline: none;
  }

  .portal-url .engine-select {
    width: 96px;
    height: 38px;
    padding: 0 10px 0 0;
    border: 0;
    border-right: 1px solid var(--border);
    border-radius: 0;
    background: #fff;
    font-size: 13px;
    outline: none;
  }

  .portal-url button {
    min-width: 74px;
    height: 38px;
    border-radius: 999px;
    font-size: 13px;
  }

  .detail-backdrop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(15, 23, 42, .28);
    z-index: 5;
  }

  .resource-detail-dialog {
    width: min(620px, 100%);
    max-height: min(760px, calc(100vh - 48px));
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 14px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 24px 60px rgba(15, 23, 42, .2);
  }

  .resource-detail-dialog header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 16px 0;
  }

  .resource-detail-dialog header div {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .resource-detail-dialog header strong {
    color: var(--text-1);
    font-size: 15px;
  }

  .resource-detail-dialog header span,
  .detail-muted {
    color: var(--text-3);
    font-size: 12px;
  }

  .detail-close {
    width: 32px;
    padding: 0;
  }

  .detail-body {
    display: grid;
    gap: 16px;
    min-height: 0;
    overflow: auto;
    padding: 0 16px 16px;
  }

  .detail-body section {
    display: grid;
    gap: 8px;
  }

  .detail-body h2,
  .detail-body h3,
  .detail-body p {
    margin: 0;
  }

  .detail-body h2 {
    color: var(--text-1);
    font-size: 18px;
    line-height: 1.3;
  }

  .detail-body h3 {
    color: var(--text-2);
    font-size: 12px;
    text-transform: uppercase;
  }

  .detail-body p,
  .detail-body a {
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .detail-evidence {
    display: grid;
    gap: 8px;
  }

  .detail-evidence article {
    display: grid;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--soft);
  }

  .detail-evidence small,
  .embedding-state small {
    color: var(--text-3);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  pre {
    margin: 0;
    max-height: 180px;
    overflow: auto;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--soft);
    color: var(--text-1);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .embedding-state {
    display: grid;
    gap: 8px;
    align-items: start;
  }

  .embedding-state span {
    width: fit-content;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--soft);
    color: var(--text-1);
    font-size: 12px;
    font-weight: 600;
  }

  .detail-muted {
    margin: 0;
    padding: 0 16px 16px;
  }
</style>
