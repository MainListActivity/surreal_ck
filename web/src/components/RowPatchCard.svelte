<script lang="ts">
  /**
   * 行分析提案卡（AI-006）：渲染 RowPatchProposal 的逐字段建议，
   * 用户逐字段接受/忽略后确认写入或全部忽略。状态流转全部在
   * 纯逻辑层 `createRowPatchCard`（单测覆盖），这里只接线 + 渲染。
   */
  import type { RecordWriteProposal, RowPatchProposal } from "@surreal-ck/shared";
  import {
    createRowPatchCard,
    formatRowPatchValue,
    type RowPatchCardState,
    type RowPatchResumeDecision,
    type RowPatchWriteResult,
  } from "../lib/row-patch-card";
  import type { AiDrawerSession } from "../lib/ai-drawer";

  type Props = {
    proposal: RowPatchProposal | RecordWriteProposal;
    /** 承载该卡的会话：确认写与 resume 都经它发，写因此带上服务端栅栏键。 */
    session: AiDrawerSession;
    messageId: string;
    /** 本次暂停的键；缺席（老事件）时回落到浏览器直写，卡片显式提示。 */
    suspendKey?: string;
    resume: (decision: RowPatchResumeDecision) => Promise<void>;
  };

  let { proposal, session, messageId, suspendKey, resume }: Props = $props();

  /**
   * PG-1：确认写走服务端受栅栏端点，写与「消费该 suspend」同一事务原子完成。
   *
   * 缺席 suspendKey（本次发布前的历史事件）或会话未开启写端点时**不做任何降级直写**——
   * 旧路径正是「浏览器先写、栅栏只是内存标志」的缺陷来源，宁可明确报错也不静默写入。
   */
  const fencedWrite = async (values: Record<string, unknown>): Promise<RowPatchWriteResult> => {
    if (!suspendKey) {
      return { ok: false, message: "这次确认已缺少防重复校验信息，请重新发起 AI 分析后再确认。" };
    }
    return session.confirmProposalWrite({ messageId, suspendKey, values });
  };

  // 卡片随 pending intent 按 key 创建/销毁，提案在组件生命周期内不变——
  // 初始值捕获是有意的。
  // svelte-ignore state_referenced_locally
  const card = createRowPatchCard({
    proposal,
    write: (values) => fencedWrite(values),
    resume: (decision) => resume(decision),
    onChange(next) {
      cardState = next;
    },
  });

  let cardState: RowPatchCardState = $state(card.snapshot());

  const acceptedCount = $derived(cardState.fields.filter((field) => field.accepted).length);
  const busy = $derived(cardState.status === "writing" || cardState.status === "rejecting");
  // stale = 服务端已具名拒绝（该 suspend 已被另一实例消费，或 run 已终态）：本次零写入是
  // 预期结果，按已处理终态呈现，而不是错误——否则用户会对一块永远成功的按钮反复重试。
  const stale = $derived(cardState.status === "stale");

  const confidenceLabel: Record<string, string> = {
    high: "高置信度",
    medium: "中置信度",
    low: "低置信度",
  };
</script>

<div class="row-patch-card" aria-label="行分析提案">
  <header>
    <strong>{proposal.type === "record-write-proposal" && proposal.operation === "create" ? "AI 新建建议" : "AI 修改建议"}</strong>
    <small>{proposal.recordId ?? proposal.sheetId}</small>
  </header>

  <ul class="proposal-list">
    <!-- 按索引遍历：归一后的提案可能含重复 field，不能用 field 名做 each key -->
    {#each cardState.fields as field, i}
      <li class:ignored={!field.accepted} class:low-confidence={field.confidence === "low"}>
        <label>
          <input
            type="checkbox"
            checked={field.accepted}
            disabled={busy || cardState.writeCommitted}
            onchange={(event) => card.setAccepted(i, event.currentTarget.checked)}
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
    <p class="write-error" class:stale-note={stale} role={stale ? "status" : "alert"}>{cardState.error}</p>
  {/if}

  {#if stale}
    <!-- 无按钮：重试在服务端语义上不可能成功（该 suspend 已消费 / run 已终态）。 -->
  {:else}
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
  {/if}
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

  .write-error.stale-note {
    background: #f1f5f9;
    color: #475569;
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
