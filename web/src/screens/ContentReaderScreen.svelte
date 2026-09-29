<script lang="ts">
  import { onMount } from "svelte";
  import { type ContentPage, type ContentReaderResult } from "../lib/content-reader";
  import { createBrowserContentReader } from "../lib/content-reader-browser";
  import { getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import { saveLegalReference } from "../lib/legal-reference";
  import { extractNativeQuotaError } from "@surreal-ck/shared/native-quota";

  let { slug, publicId, onback }: {
    slug: string;
    publicId: string;
    onback: () => void;
  } = $props();

  const reader = createBrowserContentReader();
  let page = $state<ContentPage | null>(null);
  let reason = $state<string | null>(null);
  let loading = $state(true);
  let selectedLocator = $state<string | null>(null);
  let note = $state("");
  let saveStatus = $state<"idle" | "saving" | "saved" | "denied" | "quota" | "failed">("idle");
  let sequence = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const messages: Record<string, string> = {
    invalid_id: "内容指针格式无效。",
    workspace_changed: "工作区已切换，请从当前工作区重新打开内容。",
    session_expired: "内容授权已到期，请重新验证后打开。",
    content_unavailable: "内容不存在或当前授权不允许读取正文。",
    not_member: "当前身份不是该工作区的有效成员。",
    member_removed: "成员资格已失效。",
    workspace_inactive: "工作区当前不可读取内容。",
    entitlement_absent: "当前工作区没有内容权益。",
    entitlement_expired: "内容权益已到期。",
    license_unknown: "内容来源许可尚未确认。",
    license_expired: "内容来源许可已到期。",
    content_not_published: "内容尚未发布。",
    content_withdrawn: "内容已撤回。",
    collection_denied: "当前权益不包含该内容集合。",
    action_denied: "当前权益不允许读取正文。",
    metadata_only: "当前授权仅可查看元数据。",
    projection_incomplete: "内容授权尚未完成同步。",
    projection_stale: "内容授权需要重新确认。",
    projection_closed: "内容授权已撤销。",
  };

  function clearPage() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    page = null;
    selectedLocator = null;
    saveStatus = "idle";
  }

  function chooseLocator(locator: string) {
    selectedLocator = locator;
    document.getElementById(`legal-${locator}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save() {
    const current = page;
    const workspace = getCurrentWorkspace();
    if (!current || !workspace?.dbName || workspace.slug !== slug || !current.canCite) {
      saveStatus = "denied"; return;
    }
    saveStatus = "saving";
    try {
      // Re-open through the caller's content lease before committing a pointer.
      const fresh = await reader.open(current.publicId, workspace.dbName);
      if (!fresh.ok || !fresh.page.canCite || fresh.page.versionId !== current.versionId
        || getCurrentWorkspace()?.dbName !== workspace.dbName) {
        clearPage();
        reason = "content_unavailable";
        saveStatus = "denied"; return;
      }
      await saveLegalReference({ page: fresh.page, locator: selectedLocator, note });
      saveStatus = "saved";
    } catch (error) {
      saveStatus = extractNativeQuotaError(error) ? "quota" : "failed";
    }
  }

  async function load() {
    const current = ++sequence;
    clearPage();
    reason = null;
    loading = true;
    const workspace = getCurrentWorkspace();
    if (!workspace?.dbName || workspace.slug !== slug) {
      await reader.close();
      if (current === sequence) {
        loading = false;
        reason = "workspace_changed";
      }
      return;
    }
    const result: ContentReaderResult = await reader.open(publicId, workspace.dbName);
    if (current !== sequence) return;
    if (getCurrentWorkspace()?.dbName !== workspace.dbName || getCurrentWorkspace()?.slug !== slug) {
      await reader.close();
      loading = false;
      reason = "workspace_changed";
      return;
    }
    loading = false;
    if (!result.ok) {
      reason = result.reason;
      return;
    }
    page = result.page;
    const remainingMs = Math.max(0, result.page.authorizedUntilSeconds * 1000 - Date.now());
    expiryTimer = setTimeout(() => {
      if (current !== sequence) return;
      clearPage();
      reason = "session_expired";
      void reader.close();
    }, remainingMs);
  }

  $effect(() => {
    const workspace = getCurrentWorkspace();
    const _slug = slug;
    const _publicId = publicId;
    void workspace?.dbName;
    void workspace?.slug;
    void _slug;
    void _publicId;
    void load();
    return () => {
      sequence++;
      clearPage();
      void reader.close();
    };
  });

  onMount(() => {
    const recheck = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  });
</script>

<main class="reader">
  <div class="reader-inner">
    <button class="back" type="button" onclick={onback}>← 返回工作区内容</button>
    <header>
      <span class="eyebrow">法律内容 · 独立授权阅读</span>
      <h1>{page?.title ?? "内容阅读"}</h1>
      <p>当前工作区：{slug}</p>
    </header>

    {#if loading}
      <p class="notice" role="status">正在核验成员、权益与内容授权…</p>
    {:else if reason}
      <div class="notice denied" role="alert">
        <strong>无法打开正文</strong>
        <p>{messages[reason] ?? "当前授权不允许读取，请返回工作区后重试。"}</p>
        <button type="button" onclick={() => void load()}>重新验证</button>
      </div>
    {:else if page}
      <section class="metadata" aria-label="内容版本与授权">
        <div><span>精确版本</span><strong>{page.versionLabel ?? `修订 ${page.revision}`} · #{page.revision}</strong></div>
        <div><span>来源</span><strong>{page.sourceForm} · {page.sourceUrl}</strong></div>
        <div><span>授权状态</span><strong>当前已授权读取 · 到期后需重新验证</strong></div>
        <div><span>内容指针</span><strong>{page.publicId}</strong></div>
      </section>
      {#if page.articles.length > 0}
        <nav class="locators" aria-label="法条定位">
          {#each page.articles as article (article.id)}
            <button type="button" onclick={() => chooseLocator(`article:${article.localKey}`)}>{article.label}</button>
          {/each}
        </nav>
        {#each page.articles as article (article.id)}
          <section class="body" id={`legal-article:${article.localKey}`} aria-label={article.label}>
            <h2>{article.label}</h2><p>{article.bodyText}</p>
          </section>
        {/each}
      {:else}
        <nav class="locators" aria-label="段落定位">
          {#each page.bodyText.split(/\n\s*\n/u).filter(Boolean) as paragraph, index}
            <button type="button" onclick={() => chooseLocator(`paragraph:${index + 1}`)}>第 {index + 1} 段</button>
          {/each}
        </nav>
        <article class="body" aria-label="法律内容正文">
          {#each page.bodyText.split(/\n\s*\n/u).filter(Boolean) as paragraph, index}
            <p id={`legal-paragraph:${index + 1}`}>{paragraph}</p>
          {/each}
        </article>
      {/if}
      <section class="reference" aria-label="收藏与批注">
        <h2>保存引用卡片</h2>
        <p>仅保存精确版本、来源、定位及你写的批注；平台正文不会复制到工作区。</p>
        <p>定位：{selectedLocator ?? "全文"}</p>
        <label for="legal-note">我的批注</label>
        <textarea id="legal-note" bind:value={note} maxlength="4000" rows="4"></textarea>
        <button type="button" disabled={!page.canCite || saveStatus === "saving"} onclick={() => void save()}>保存到工作区</button>
        {#if !page.canCite}<p role="status">当前许可不允许引用或收藏。</p>{/if}
        {#if saveStatus === "saved"}<p role="status">引用已保存。</p>{/if}
        {#if saveStatus === "denied"}<p role="alert">当前内容授权已变化，未保存引用。</p>{/if}
        {#if saveStatus === "quota"}<p role="alert">工作区记录配额已满，引用未保存。</p>{/if}
        {#if saveStatus === "failed"}<p role="alert">引用保存失败，请检查工作区连接后重试。</p>{/if}
      </section>
    {/if}
  </div>
</main>

<style>
  .reader { min-height: 100vh; overflow: auto; background: var(--bg); padding: 32px 24px 80px; }
  .reader-inner { max-width: 920px; margin: 0 auto; }
  .back { border: 0; background: transparent; color: var(--brand-strong); cursor: pointer; padding: 0 0 22px; font-weight: 650; }
  header { border-bottom: 1px solid var(--border); padding-bottom: 22px; }
  .eyebrow { color: var(--brand-strong); font-size: 12px; font-weight: 700; letter-spacing: .07em; }
  h1 { margin: 12px 0 8px; font-family: var(--font-serif); font-size: clamp(25px, 4vw, 38px); }
  header p { color: var(--text-3); margin: 0; }
  .metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
  .metadata div { min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 14px; }
  .metadata span { display: block; color: var(--text-3); font-size: 12px; margin-bottom: 7px; }
  .metadata strong { display: block; overflow-wrap: anywhere; font-size: 14px; font-weight: 600; }
  .body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.9; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 28px; }
  .locators { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
  .locators button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 7px 10px; cursor: pointer; }
  .reference { margin-top: 24px; padding: 24px; border: 1px solid var(--border); border-radius: 12px; }
  .reference label { display: block; margin-bottom: 8px; }
  .reference textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px; }
  .reference button { margin-top: 10px; border: 0; border-radius: 8px; background: var(--primary); color: white; padding: 10px 16px; }
  .notice { margin: 28px 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 24px; }
  .denied { border-color: var(--error); }
  .denied strong { color: var(--error); }
  .denied button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 8px 12px; cursor: pointer; }
  @media (max-width: 640px) { .metadata { grid-template-columns: 1fr; } .reader { padding: 20px 16px 48px; } }
</style>
