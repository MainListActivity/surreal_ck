<script lang="ts">
  /**
   * 行分析提案卡（AI-006）：渲染 RowPatchProposal 的逐字段建议，
   * 用户逐字段接受/忽略后确认写入或全部忽略。状态流转全部在
   * 纯逻辑层 `createRowPatchCard`（单测覆盖），这里只接线 + 渲染。
   */
  import type { RowPatchProposal } from "@surreal-ck/shared";
  import {
    createRowPatchCard,
    formatRowPatchValue,
    type RowPatchCardState,
    type RowPatchResumeDecision,
    type RowPatchWriteResult,
  } from "../lib/row-patch-card";

  type Props = {
    proposal: RowPatchProposal;
    write: (values: Record<string, unknown>) => Promise<RowPatchWriteResult>;
    resume: (decision: RowPatchResumeDecision) => Promise<void>;
  };

  let { proposal, write, resume }: Props = $props();

  // 卡片随 pending intent 按 key 创建/销毁，提案在组件生命周期内不变——
  // 初始值捕获是有意的。
  // svelte-ignore state_referenced_locally
  const card = createRowPatchCard({
    proposal,
    write: (values) => write(values),
    resume: (decision) => resume(decision),
    onChange(next) {
      cardState = next;
    },
  });

  let cardState: RowPatchCardState = $state(card.snapshot());

  const acceptedCount = $derived(cardState.fields.filter((field) => field.accepted).length);
  const busy = $derived(cardState.status === "writing" || cardState.status === "rejecting");

  const confidenceLabel: Record<string, string> = {
    high: "高置信度",
    medium: "中置信度",
    low: "低置信度",
  };
</script>

<div class="row-patch-card" aria-label="行分析提案">
  <header>
    <strong>AI 修改建议</strong>
    <small>{proposal.recordId}</small>
  </header>

  <ul class="proposal-list">
    {#each cardState.fields as field (field.field)}
      <li class:ignored={!field.accepted} class:low-confidence={field.confidence === "low"}>
        <label>
          <input
            type="checkbox"
            checked={field.accepted}
            disabled={busy || cardState.writeCommitted}
            onchange={(event) => card.setAccepted(field.field, event.currentTarget.checked)}
          />
          <span class="field-name">{field.field}</span>
          <span class="confidence" data-level={field.confidence}>{confidenceLabel[field.confidence]}</span>
        </label>
        <p class="values">
          <s>{formatRowPatchValue(field.currentValue)}</s>
          <span class="arrow">→</span>
          <strong>{formatRowPatchValue(field.suggestedValue)}</strong>
        </p>
        <p class="basis">{field.basis}</p>
      </li>
    {/each}
  </ul>

  {#if cardState.error}
    <p class="write-error" role="alert">{cardState.error}</p>
  {/if}

  <footer>
    <button
      type="button"
      class="primary-btn"
      disabled={busy}
      onclick={() => void card.confirm()}
    >
      {cardState.status === "writing"
        ? (cardState.writeCommitted ? "再次提交中…" : "写入中…")
        : cardState.writeCommitted
          ? "再次提交确认"
          : `确认写入（${acceptedCount} 个字段）`}
    </button>
    <button type="button" class="ghost-btn" disabled={busy || cardState.writeCommitted} onclick={() => void card.rejectAll()}>
      全部忽略
    </button>
  </footer>
</div>

<style>
  .row-patch-card {
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

  .proposal-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .proposal-list li {
    padding: 8px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #fff;
  }

  .proposal-list li.ignored {
    opacity: 0.55;
  }

  .proposal-list li.low-confidence {
    border-color: #fcd34d;
    background: #fffbeb;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .field-name {
    font-weight: 600;
    font-size: 12px;
  }

  .confidence {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    background: #f1f5f9;
    color: #475569;
    font-size: 10px;
  }

  .confidence[data-level="low"] {
    background: #fef3c7;
    color: #92400e;
  }

  .values {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 0;
    font-size: 12px;
  }

  .values s {
    color: #94a3b8;
  }

  .arrow {
    color: #64748b;
  }

  .basis {
    margin: 4px 0 0;
    color: #64748b;
    font-size: 11px;
  }

  .write-error {
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
