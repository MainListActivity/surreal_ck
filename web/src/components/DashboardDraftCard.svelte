<script lang="ts">
  /**
   * AI 仪表盘草稿卡（D3-05）：渲染 dashboard-draft 暂停事件的图表草稿——
   * 标题、explanation、真实数据预览（D3-02 编译器只读直连 + D3-03 widget 组件，
   * 零 AI 特化分支），用户确认后直连写 dashboard_page 并 resume。状态流转全部在
   * 纯逻辑层 `createDashboardDraftCard`（单测覆盖），这里只接线 + 渲染。
   */
  import type { DashboardDraftIntent, DashboardPreviewResponse } from "@surreal-ck/shared";
  import { getDashboardWidget } from "../features/dashboard/registries/widgets";
  import {
    createDashboardDraftCard,
    type DashboardDraftCardState,
    type PersistDashboardDraftResult,
  } from "../features/dashboard/lib/dashboard-draft-card";

  type Props = {
    intent: DashboardDraftIntent;
    preview: () => Promise<DashboardPreviewResponse>;
    save: () => Promise<PersistDashboardDraftResult>;
    resume: (decision: { kind: "write-confirmed" | "write-rejected" }) => Promise<void>;
  };

  let { intent, preview, save, resume }: Props = $props();

  // 卡片随 pending intent 按 key 创建/销毁，草稿在组件生命周期内不变——
  // 初始值捕获是有意的。
  // svelte-ignore state_referenced_locally
  const card = createDashboardDraftCard({
    intent,
    preview: () => preview(),
    save: () => save(),
    resume: (decision) => resume(decision),
    onChange(next) {
      cardState = next;
    },
  });

  let cardState: DashboardDraftCardState = $state(card.snapshot());

  void card.loadPreview();

  const registration = $derived(getDashboardWidget(intent.draft.viewType));
  const busy = $derived(cardState.status === "saving" || cardState.status === "rejecting");
  const canSave = $derived(cardState.status === "ready" || cardState.status === "error" || busy);
</script>

<div class="dashboard-draft-card" aria-label="AI 图表草稿">
  <header>
    <strong>{intent.title}</strong>
    <small>图表草稿</small>
  </header>

  <p class="explanation">{intent.explanation}</p>

  {#if cardState.status === "previewing"}
    <p class="preview-loading">正在用当前数据生成预览…</p>
  {:else if cardState.preview && registration}
    <div class="preview">
      <registration.component
        title={intent.title}
        result={cardState.preview.result}
        displaySpec={intent.draft.displaySpec}
      />
    </div>
  {/if}

  {#if cardState.error}
    <p class="card-error" role="alert">
      {cardState.status === "preview-error" ? `预览失败：${cardState.error}` : cardState.error}
    </p>
  {/if}

  <footer>
    {#if canSave}
      <button type="button" class="primary-btn" disabled={busy} onclick={() => void card.confirm()}>
        {cardState.status === "saving"
          ? (cardState.saved ? "再次提交中…" : "保存中…")
          : cardState.saved
            ? "再次提交确认"
            : "保存到仪表盘"}
      </button>
    {/if}
    <button type="button" class="ghost-btn" disabled={busy || cardState.saved !== null} onclick={() => void card.reject()}>
      忽略
    </button>
  </footer>
</div>

<style>
  .dashboard-draft-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  header small {
    color: #64748b;
    font-size: 11px;
  }

  .explanation {
    margin: 0;
    color: #475569;
    font-size: 12px;
    line-height: 1.5;
  }

  .preview-loading {
    margin: 0;
    padding: 14px 8px;
    color: #64748b;
    font-size: 12px;
    text-align: center;
  }

  .preview {
    padding: 8px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #fff;
  }

  .card-error {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 12px;
  }

  footer {
    display: flex;
    gap: 8px;
  }

  .primary-btn {
    padding: 6px 12px;
    border: none;
    border-radius: 8px;
    background: #4f46e5;
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }

  .primary-btn:disabled,
  .ghost-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .ghost-btn {
    padding: 6px 12px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #fff;
    color: #475569;
    font-size: 12px;
    cursor: pointer;
  }
</style>
