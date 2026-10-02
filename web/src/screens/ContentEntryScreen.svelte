<script lang="ts">
  import { onMount } from "svelte";
  import { contentReaderExchangeRequestSchema } from "@surreal-ck/shared";
  import { type LegalSearchFilters, type LegalSearchResult, type LegalSearchState } from "../lib/content-search";
  import { createBrowserContentSearch, searchBrowserLegalSemantics } from "../lib/content-search-browser";
  import type { LegalRetrievalHit } from "@surreal-ck/shared";
  import { getSurreal } from "../lib/surreal";

  let { onopen }: { onopen: (publicId: string) => void } = $props();
  const searcher = createBrowserContentSearch();
  let pointer = $state("");
  let invalid = $state(false);
  let filters = $state<LegalSearchFilters>({ keyword: "", kind: "all", publishedFrom: "", publishedUntil: "", jurisdiction: "", effectiveOn: "" });
  let searchStatus = $state<LegalSearchState | "loading">("loading");
  let results = $state<LegalSearchResult[]>([]);
  let total = $state(0);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let semantic = $state(false);
  let semanticHits = $state<LegalRetrievalHit[]>([]);
  let retrievalNotice = $state("");
  let error = $state(false);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let saved = $state<Array<{ id: string; content_public_id: string; content_version_id: string; title: string; locator?: string; note?: string }>>([]);
  let savedError = $state(false);

  async function loadSaved() {
    try {
      saved = await getSurreal().query("SELECT id, created_at, content_public_id, content_version_id, title, locator, note FROM legal_reference ORDER BY created_at DESC LIMIT 100;");
      savedError = false;
    } catch { saved = []; savedError = true; }
  }

  async function openSearch() {
    if (expiryTimer) clearTimeout(expiryTimer);
    searchStatus = "loading"; error = false;
    try {
      searchStatus = await searcher.open();
      if (searchStatus === "ready") {
        const remaining = Math.max(0, searcher.deadlineSeconds() * 1000 - Date.now());
        expiryTimer = setTimeout(() => {
          results = []; semanticHits = []; cursor = null; searchStatus = "unavailable";
          void searcher.close();
        }, remaining);
        await runSearch(false);
      }
    } catch { searchStatus = "unavailable"; }
  }
  async function runSearch(append: boolean) {
    busy = true; error = false;
    try {
      semanticHits = []; retrievalNotice = "";
      if (semantic && filters.keyword.trim()) {
        const page = await searchBrowserLegalSemantics({
          query: filters.keyword, kind: filters.kind, jurisdiction: filters.jurisdiction,
          effectiveOn: filters.effectiveOn, publishedFrom: filters.publishedFrom, publishedUntil: filters.publishedUntil,
        });
        results = []; semanticHits = page.items; retrievalNotice = page.notice;
        total = page.items.length; cursor = null;
        return;
      }
      const page = await searcher.search(filters, append ? cursor : null);
      results = append ? [...results, ...page.items] : page.items;
      total = page.total; cursor = page.nextCursor;
    } catch { error = true; semanticHits = []; if (!append) results = []; }
    finally { busy = false; }
  }
  function submitPointer(event: SubmitEvent) {
    event.preventDefault();
    const result = contentReaderExchangeRequestSchema.safeParse({ contentPublicId: pointer });
    invalid = !result.success;
    if (result.success) onopen(result.data.contentPublicId);
  }
  onMount(() => { void openSearch(); void loadSaved(); return () => { if (expiryTimer) clearTimeout(expiryTimer); void searcher.close(); }; });
</script>

<section class="entry">
  <span class="eyebrow">工作区内容</span>
  <h1>检索授权内容</h1>
  <p>检索只在当前工作区授权的内容范围内执行。打开正文时再次核验成员、来源许可与精确版本；检索和阅读不扣 AI 额度。</p>
  {#if searchStatus === "loading"}
    <p role="status">正在建立短期内容检索会话…</p>
  {:else if searchStatus === "not_member"}
    <p role="alert">当前身份不是工作区有效成员，无法检索内容。</p>
  {:else if searchStatus === "not_authorized"}
    <p role="alert">当前工作区缺少内容检索授权。</p>
  {:else if searchStatus === "unavailable"}
    <p role="alert">内容平台暂不可用，请稍后重试。</p>
    <button type="button" onclick={() => void openSearch()}>重试</button>
  {:else if searchStatus === "empty"}
    <p role="status">当前授权范围内暂无已发布内容。</p>
    <button type="button" onclick={() => void openSearch()}>刷新发布内容</button>
  {:else}
    <form class="filters" onsubmit={(event) => { event.preventDefault(); void runSearch(false); }}>
      <label>问题或关键词<input bind:value={filters.keyword} placeholder="例如：合同未签字，履行后是否成立？" /></label>
      <label><span>检索方式</span><select bind:value={semantic}><option value={false}>关键词</option><option value={true}>关键词 + 语义</option></select></label>
      <label>类型<select bind:value={filters.kind}><option value="all">全部</option><option value="legislation">法规</option><option value="judicial_document">案例</option></select></label>
      <label>发布起日<input type="date" bind:value={filters.publishedFrom} /></label>
      <label>发布止日<input type="date" bind:value={filters.publishedUntil} /></label>
      <label>法域<input bind:value={filters.jurisdiction} placeholder="已收录法域" /></label>
      <label>生效日期<input type="date" bind:value={filters.effectiveOn} /></label>
      <button type="submit" disabled={busy}>检索</button>
    </form>
    {#if error}
      <p role="alert">检索失败或会话已到期；结果可能不完整。请重新建立授权会话。</p>
      <button type="button" onclick={() => void openSearch()}>重新验证</button>
    {:else if !busy && results.length === 0 && semanticHits.length === 0}
      <p role="status">没有符合条件的授权内容。</p>
      {#if retrievalNotice}<p role="status">{retrievalNotice}</p>{/if}
    {:else}
      <p role="status">授权范围内共 {total} 条结果。</p>
      {#if retrievalNotice}<p role="status">{retrievalNotice}</p>{/if}
      <ul class="results">
        {#each semanticHits as hit (hit.versionId)}
          <li>
            <button type="button" onclick={() => onopen(hit.publicId)}>{hit.title}</button>
            <small>{hit.versionLabel ?? `修订 ${hit.revision}`} · {hit.explanation.join(" · ")}</small>
            {#each hit.sources as source (source.versionId)}
              <small>来源：{source.sourceUrl} · <button type="button" onclick={() => onopen(source.publicId)}>打开精确版本</button></small>
            {/each}
          </li>
        {/each}
        {#each results as item (item.id)}
          <li>
            <button type="button" onclick={() => onopen(item.publicId)}>{item.title}</button>
            <small>{item.kind === "legislation" ? "法规" : "案例"} · {item.versionLabel ?? `修订 ${item.revision}`} · {item.publishedOn ?? "发布时间未收录"} · {item.jurisdiction ?? "法域未收录"} · {item.effectiveOn ?? "效力日期未收录"}</small>
            <small>来源：{item.sourceUrl}</small>
          </li>
        {/each}
      </ul>
      {#if cursor}<button type="button" disabled={busy} onclick={() => void runSearch(true)}>加载更多</button>{/if}
      {#if results.some((item) => !item.jurisdiction || !item.publishedOn || !item.effectiveOn)}<p class="coverage">部分来源未提供法域、发布日期或效力日期，相关过滤结果可能不完整。</p>{/if}
    {/if}
  {/if}
  <section class="saved" aria-label="工作区引用卡片">
    <h2>已保存的引用</h2>
    {#if savedError}<p role="alert">工作区引用卡片暂不可用。</p>
    {:else if saved.length === 0}<p>暂无引用卡片。</p>{/if}
    <ul class="results">
      {#each saved as card (String(card.id))}
        <li>
          <button type="button" onclick={() => onopen(card.content_public_id)}>{card.title}</button>
          <small>精确版本 {card.content_version_id} · {card.locator ?? "全文"}；打开时重新核验当前授权。</small>
          {#if card.note}<p>{card.note}</p>{/if}
        </li>
      {/each}
    </ul>
  </section>
  <details>
    <summary>按公开指针打开已知内容</summary>
    <form class="pointer" onsubmit={submitPointer}>
      <label for="content-public-id">内容公开 ID</label>
      <input id="content-public-id" bind:value={pointer} autocomplete="off" spellcheck="false" aria-invalid={invalid} />
      <button type="submit">验证并打开</button>
      {#if invalid}<small role="alert">请输入有效的公开内容 ID。</small>{/if}
    </form>
  </details>
</section>

<style>
  .entry { max-width: 900px; padding: 44px; }
  .eyebrow { color: var(--brand-strong); font-size: 12px; font-weight: 700; letter-spacing: .07em; }
  h1 { font-family: var(--font-serif); font-size: 32px; margin: 12px 0; }
  p { color: var(--text-2); line-height: 1.7; }
  .filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
  label { display: grid; gap: 7px; font-weight: 600; }
  input, select { min-width: 0; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); padding: 10px; }
  button { border: 0; border-radius: 9px; background: var(--primary); color: white; padding: 10px 16px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  .results { list-style: none; padding: 0; display: grid; gap: 12px; }
  .results li { display: grid; gap: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 16px; }
  .results button { justify-self: start; background: transparent; color: var(--brand-strong); padding: 0; text-align: left; font-weight: 700; }
  small, .coverage { color: var(--text-3); overflow-wrap: anywhere; }
  details { margin-top: 30px; border-top: 1px solid var(--border); padding-top: 16px; }
  .saved { margin-top: 30px; border-top: 1px solid var(--border); padding-top: 16px; }
  .pointer { display: grid; gap: 10px; margin-top: 12px; }
  @media (max-width: 640px) { .entry { padding: 24px; } .filters { grid-template-columns: 1fr; } }
</style>
