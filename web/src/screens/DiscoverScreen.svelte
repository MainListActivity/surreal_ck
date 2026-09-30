<script lang="ts">
  import { onMount } from "svelte";
  import type { DiscoverEvaluation, DiscoverMatchedItem, DiscoverOverview } from "@surreal-ck/shared";
  import {
    askDiscover,
    coverageLabel,
    fetchDiscoverOverview,
    kindLabel,
    sendDiscoverEvent,
  } from "../lib/discover";
  import { isAuthenticated } from "../lib/auth";

  /**
   * LCA11 公开发现页：访客和登录成员共用。
   * 访客看到覆盖范围、安全聚合、策划示例与有限元数据；
   * 登录成员额外得到有依据的覆盖结论（full/partial/locked/unavailable）
   * 和至多一个下一步建议。页面不展示正文、摘要或裁判结论。
   */
  let { onlogin }: { onlogin?: () => void } = $props();

  let overview = $state<DiscoverOverview | null>(null);
  let overviewError = $state(false);
  let question = $state("");
  let asking = $state(false);
  let askError = $state<string | null>(null);
  let result = $state<DiscoverEvaluation | null>(null);
  let suggestionDismissed = $state(false);
  let suggestionActed = $state<string | null>(null);

  const member = $derived(isAuthenticated());

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    asking = true;
    askError = null;
    result = null;
    suggestionDismissed = false;
    suggestionActed = null;
    try {
      const next = await askDiscover(q, member);
      result = { coverage: "unavailable", coveredCollections: [], gapCollections: [], suggestion: null, entry: { kind: "none", planKey: null }, retainedNote: "", ...next };
    } catch (error) {
      askError = error instanceof Error ? error.message : "查询失败";
    } finally {
      asking = false;
    }
  }

  function dismissSuggestion() {
    if (!result?.suggestion) return;
    suggestionDismissed = true;
    void sendDiscoverEvent({
      kind: "suggestion_dismissed",
      scopeKinds: result.scope.kinds,
      scopeCollections: result.scope.collectionKeys,
      planKey: result.suggestion.planKey,
      moduleKey: null,
      conversion: "dismissed",
    });
  }

  function actOnSuggestion() {
    const suggestion = result?.suggestion;
    if (!suggestion) return;
    suggestionActed = result?.entry.kind === "upgrade" ? "upgrade" : "request";
    void sendDiscoverEvent({
      kind: result?.entry.kind === "upgrade" ? "entry_click" : "entry_request",
      scopeKinds: result?.scope.kinds ?? [],
      scopeCollections: result?.suggestion?.coversCollections ?? [],
      planKey: suggestion.planKey,
      moduleKey: null,
      conversion: result?.entry.kind === "upgrade" ? "clicked" : "requested",
    });
  }

  onMount(() => {
    void fetchDiscoverOverview()
      .then((value) => { overview = value; })
      .catch(() => { overviewError = true; });
  });
</script>

<main class="discover">
  <span class="eyebrow">平台覆盖预览</span>
  <h1>平台能回答什么</h1>
  <p>
    输入你的研究问题，了解平台内容覆盖范围。这里不会给出法律结论或全文，
    只展示许可允许公开的范围标签、有限元数据与示例。
  </p>

  <form class="ask" onsubmit={(event) => { event.preventDefault(); void ask(); }}>
    <label for="discover-question">描述你的研究问题</label>
    <textarea id="discover-question" bind:value={question} rows="3" maxlength="500"
      placeholder="例如：建设工程价款优先受偿权的行使期限"></textarea>
    <button type="submit" disabled={asking || !question.trim()}>{asking ? "正在分析范围…" : "了解覆盖范围"}</button>
  </form>
  {#if askError}<p role="alert">{askError}</p>{/if}

  {#if result}
    <section class="scope" aria-label="研究范围解释">
      <h2>理解到的研究范围</h2>
      {#if result.scope.matchedCount === 0}
        <p>当前公开投影中没有与问题直接匹配的条目，平台证据不足，不能据此判断购买后一定可以完成研究。</p>
      {:else}
        <p>
          命中 {result.scope.matchedCount} 条公开条目
          {#if result.scope.kinds.length}，类别：{result.scope.kinds.map(kindLabel).join("、")}{/if}
          {#if result.scope.jurisdictions.length}，法域：{result.scope.jurisdictions.join("、")}{/if}。
        </p>
        <ul class="items">
          {#each result.matchedItems as item (item.publicId)}
            <li>
              <strong>{item.title}</strong>
              <small>
                {kindLabel(item.kind)}
                {#if item.jurisdiction} · {item.jurisdiction}{/if}
                {#if item.publishedOn} · 发布于 {item.publishedOn}{/if}
                · {item.sourceLabel}
              </small>
              {#if item.collectionKeys.length}
                <small>内容集合：{item.collectionKeys.join("、")}</small>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if member}
        <section class="coverage-card" aria-label="覆盖结论">
          <h3>你的工作区覆盖结论：{coverageLabel(result.coverage)}</h3>
          <p>{result.retainedNote}</p>
          {#if result.gapCollections.length}
            <p>缺口集合：{result.gapCollections.join("、")}</p>
          {/if}
          {#if result.suggestion && !suggestionDismissed}
            <div class="suggestion">
              <p>
                建议升级到 <strong>{result.suggestion.planName}</strong> 可补齐缺口集合
                （{result.suggestion.coversCollections.join("、")}）。
              </p>
              {#if suggestionActed}
                <p role="status">已记录你的意向。购买通道尚未在线开放，平台会按记录与你或管理员确认。</p>
              {:else if result.entry.kind === "upgrade"}
                <button type="button" onclick={actOnSuggestion}>申请升级到 {result.suggestion.planName}</button>
              {:else if result.entry.kind === "request_admin"}
                <button type="button" onclick={actOnSuggestion}>请管理员评估升级 {result.suggestion.planName}</button>
              {/if}
              <button type="button" class="ghost" onclick={dismissSuggestion}>本次研究不再提示</button>
            </div>
          {:else if !result.suggestion && (result.coverage === "partial" || result.coverage === "locked")}
            <p>暂无已配置套餐可以完整补齐缺口；证据不足时我们不会承诺购买即可解决。</p>
          {/if}
        </section>
      {:else}
        <p class="login-hint">
          登录后可以对照你的工作区权益得到覆盖结论。
          {#if onlogin}<button type="button" class="ghost" onclick={onlogin}>前往登录</button>{/if}
        </p>
      {/if}
    </section>
  {/if}

  <section class="aggregates" aria-label="平台覆盖统计">
    <h2>覆盖范围</h2>
    {#if overviewError}
      <p role="alert">覆盖统计暂不可用。</p>
    {:else if !overview}
      <p role="status">正在加载覆盖统计…</p>
    {:else}
      <p>共 {overview.aggregates.totalItems} 条已发布条目
        {#if overview.aggregates.latestPublishedOn}，最近更新 {overview.aggregates.latestPublishedOn}{/if}。
      </p>
      {#if overview.aggregates.kinds.length}
        <p>类别：{overview.aggregates.kinds.map((k) => `${kindLabel(k.key)} ${k.count}`).join("，")}</p>
      {/if}
      {#if overview.aggregates.jurisdictions.length}
        <p>法域：{overview.aggregates.jurisdictions.map((j) => `${j.key} ${j.count}`).join("，")}</p>
      {/if}
      {#if overview.aggregates.collections.length}
        <p>内容集合：{overview.aggregates.collections.map((c) => `${c.key} ${c.count}`).join("，")}</p>
      {/if}
    {/if}
  </section>

  {#if overview?.examples.length}
    <section class="examples" aria-label="策划示例">
      <h2>示例</h2>
      <ul class="items">
        {#each overview.examples as example (example.key)}
          <li>
            <strong>{example.title}</strong>
            <p>{example.summary}</p>
            {#if example.citationLabels.length}
              <small>可公开引用：{example.citationLabels.join("、")}</small>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  .discover { max-width: 900px; padding: 44px; margin: 0 auto; }
  .eyebrow { color: var(--brand-strong); font-size: 12px; font-weight: 700; letter-spacing: .07em; }
  h1 { font-family: var(--font-serif); font-size: 32px; margin: 12px 0; }
  h2 { font-size: 20px; margin: 24px 0 8px; }
  h3 { font-size: 16px; margin: 0 0 8px; }
  p { color: var(--text-2); line-height: 1.7; }
  .ask { display: grid; gap: 10px; margin: 20px 0; }
  label { font-weight: 600; }
  textarea { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); padding: 10px; font: inherit; resize: vertical; }
  button { border: 0; border-radius: 9px; background: var(--primary); color: white; padding: 10px 16px; cursor: pointer; justify-self: start; }
  button:disabled { opacity: .6; cursor: wait; }
  button.ghost { background: transparent; color: var(--brand-strong); font-weight: 700; padding: 10px 0; }
  .items { list-style: none; padding: 0; display: grid; gap: 12px; }
  .items li { display: grid; gap: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 16px; }
  small { color: var(--text-3); overflow-wrap: anywhere; }
  .coverage-card { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 16px; margin-top: 16px; }
  .suggestion { border-top: 1px dashed var(--border); margin-top: 12px; padding-top: 12px; }
  .login-hint { margin-top: 16px; }
  .aggregates, .examples { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 16px; }
  @media (max-width: 640px) { .discover { padding: 24px; } }
</style>
