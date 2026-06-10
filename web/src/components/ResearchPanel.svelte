<svelte:options runes={true} />

<!--
  RR-012 人工检索 panel：query / resourceType 展示、手动粘贴证据篮、
  资源草稿编辑、SSE 保存进度与失败保留、完成检索。
  状态机在 lib/research-panel.ts（纯逻辑，单测覆盖），组件只做渲染与事件转发。
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import { createResearchPanelSession, type ResearchPanelState } from "../lib/research-panel";
  import { createResearchSaveClient } from "../lib/research-save-client";

  type Props = {
    sessionId: string;
    runId?: string;
    query: string;
    resourceType: string;
    /** 完成检索：置 research_session completed + resume workflow（由 AiDrawer 注入）。 */
    finish: (input: { sessionId: string; runId?: string; resourceIds: string[] }) => Promise<void>;
  };

  let { sessionId, runId, query, resourceType, finish }: Props = $props();

  const saveClient = createResearchSaveClient();
  // 一个 panel 实例对应一个 manual-research intent（AiDrawer 按 messageId-kind key），
  // 会话上下文取挂载时的 props 即可——这些值在 intent 生命周期内不变。
  // svelte-ignore state_referenced_locally
  const panel = createResearchPanelSession({
    context: { sessionId, runId, query, resourceType },
    saveAction: (request, onEvent) => saveClient.save(request, onEvent),
    finishAction: (input) => finish(input),
    onChange(next) {
      panelState = next;
    },
  });

  let panelState: ResearchPanelState = $state(panel.snapshot());

  let evidenceText = $state("");
  let evidenceUrl = $state("");
  let evidenceTitle = $state("");
  let tagsText = $state("");

  const PROGRESS_LABEL: Record<string, string> = {
    validating: "校验草稿…",
    embedding: "生成向量…",
    persisting: "写入资源…",
    "session-updated": "更新检索会话…",
  };

  function addEvidence(): void {
    panel.addEvidence({ text: evidenceText, sourceUrl: evidenceUrl, sourceTitle: evidenceTitle });
    evidenceText = "";
  }

  function syncTags(): void {
    panel.updateDraft({
      tags: tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    });
  }

  async function save(): Promise<void> {
    syncTags();
    await panel.save();
    if (!panel.snapshot().saveError) tagsText = "";
  }
</script>

<section class="research-panel" aria-label="人工检索">
  <header>
    <Icon name="search" size={14} />
    <div class="head-copy">
      <strong>人工检索：{panelState.context.query}</strong>
      <small>已保存 {panelState.savedResourceIds.length} 个资源</small>
    </div>
  </header>

  <div class="block">
    <span class="block-title">证据篮（手动粘贴）</span>
    {#if panelState.evidence.length}
      <ul class="evidence-list">
        {#each panelState.evidence as item (item.order)}
          <li>
            <p>{item.text}</p>
            {#if item.sourceTitle || item.sourceUrl}
              <small>{item.sourceTitle ?? ""} {item.sourceUrl ?? ""}</small>
            {/if}
            <button type="button" class="link-btn" onclick={() => panel.removeEvidence(item.order)}>删除</button>
          </li>
        {/each}
      </ul>
    {/if}
    <textarea rows="3" placeholder="把外部页面里的证据文本粘贴到这里" bind:value={evidenceText}></textarea>
    <div class="field-row">
      <input type="url" placeholder="来源 URL（http/https，可选）" bind:value={evidenceUrl} />
      <input type="text" placeholder="来源标题（可选）" bind:value={evidenceTitle} />
    </div>
    <button type="button" class="secondary-btn" disabled={!evidenceText.trim()} onclick={addEvidence}>
      添加证据
    </button>
  </div>

  <div class="block">
    <span class="block-title">资源草稿</span>
    <div class="field-row">
      <select
        value={panelState.draft.resourceType}
        onchange={(event) => panel.updateDraft({ resourceType: (event.currentTarget as HTMLSelectElement).value })}
      >
        <option value="generic_note">通用笔记</option>
        <option value="web_article">网页文章</option>
      </select>
      <input
        type="text"
        placeholder="标题"
        value={panelState.draft.title}
        oninput={(event) => panel.updateDraft({ title: (event.currentTarget as HTMLInputElement).value })}
      />
    </div>
    <textarea
      rows="3"
      placeholder="结论 / 摘要"
      value={panelState.draft.summary}
      oninput={(event) => panel.updateDraft({ summary: (event.currentTarget as HTMLTextAreaElement).value })}
    ></textarea>
    <div class="field-row">
      <input
        type="url"
        placeholder="资源来源 URL（web_article 必填）"
        value={panelState.draft.sourceUrl}
        oninput={(event) => panel.updateDraft({ sourceUrl: (event.currentTarget as HTMLInputElement).value })}
      />
      <input
        type="text"
        placeholder="资源来源标题"
        value={panelState.draft.sourceTitle}
        oninput={(event) => panel.updateDraft({ sourceTitle: (event.currentTarget as HTMLInputElement).value })}
      />
    </div>
    <input type="text" placeholder="标签（逗号分隔，可选）" bind:value={tagsText} onblur={syncTags} />
  </div>

  {#if panelState.saveProgress !== "idle"}
    <p class="progress" aria-live="polite">{PROGRESS_LABEL[panelState.saveProgress] ?? "保存中…"}</p>
  {/if}
  {#if panelState.saveError}
    <p class="error">保存失败（{panelState.saveError.message}）。草稿与证据已保留，可修改后再次保存。</p>
  {/if}
  {#if panelState.finishError}
    <p class="error">完成检索失败：{panelState.finishError}，可重试。</p>
  {/if}
  {#if panelState.finished}
    <p class="progress">检索已完成，AI 正在基于已保存资源继续回答。</p>
  {/if}

  <footer>
    <button type="button" class="secondary-btn" disabled={!panelState.canSave} onclick={() => void save()}>
      {panelState.saveProgress === "idle" ? "保存资源" : "保存中…"}
    </button>
    <button type="button" class="primary-btn" disabled={!panelState.canFinish} onclick={() => void panel.finish()}>
      完成检索
    </button>
  </footer>
</section>

<style>
  .research-panel {
    display: grid;
    gap: 10px;
    font-size: 12px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
  }

  .head-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .head-copy strong {
    overflow: hidden;
    color: var(--text-1);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-copy small {
    color: var(--text-3);
  }

  .block {
    display: grid;
    gap: 6px;
  }

  .block-title {
    color: var(--text-3);
    font-weight: 600;
  }

  .evidence-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .evidence-list li {
    display: grid;
    gap: 3px;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
  }

  .evidence-list p {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--text-1);
    line-height: 1.5;
  }

  .evidence-list small {
    overflow-wrap: anywhere;
    color: var(--text-3);
  }

  .link-btn {
    justify-self: end;
    padding: 0;
    border: 0;
    background: none;
    color: var(--primary);
    cursor: pointer;
    font-size: 11px;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  textarea,
  input,
  select {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border-dark);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    line-height: 1.5;
  }

  textarea {
    resize: vertical;
  }

  .progress {
    margin: 0;
    color: var(--primary);
  }

  .error {
    margin: 0;
    color: var(--error);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .secondary-btn {
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--border-dark);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }

  .primary-btn {
    height: 30px;
    padding: 0 12px;
    cursor: pointer;
  }

  .secondary-btn:disabled,
  .primary-btn:disabled {
    cursor: not-allowed;
    opacity: .55;
  }
</style>
