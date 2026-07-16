import type { RecordWriteProposal, RowPatchProposal } from "@surreal-ck/shared";

export type ConfirmableRecordProposal = RowPatchProposal | RecordWriteProposal;

/**
 * 行分析提案卡的纯逻辑状态机（AI-006）。
 *
 * Router workflow 在写操作前 suspend，提案（RowPatchProposal）经 chat stream
 * 推到 AI 抽屉；本模块管理「逐字段接受/忽略 → 确认写入 → resume」的状态流转，
 * 与 svelte runes 镜像分离（沿用 editor-store 的分层风格）：
 * - 写入通过注入的 `write` 完成（生产接当前 DataTableRuntime，复用编辑器
 *   同一套字段约束 / 编解码 / 调度与错误语义）；
 * - resume 通过注入的 `resume` 完成（生产接 ai-drawer session 的 resumeWrite）。
 *
 * 写入失败（含 PERMISSIONS 拒绝）时卡片保留并展示中文错误，**不**以
 * write-confirmed resume；用户可重试或全部忽略。
 */

export type RowPatchWriteResult = { ok: true } | { ok: false; message: string };

export type RowPatchResumeDecision = { kind: "write-confirmed" | "write-rejected" };

export type RowPatchFieldView = {
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  basis: string;
  confidence: "high" | "medium" | "low";
  accepted: boolean;
};

export type RowPatchCardState = {
  status: "pending" | "writing" | "rejecting" | "done" | "rejected" | "error";
  fields: RowPatchFieldView[];
  error: string | null;
  /** 写入已成功、仅 workflow resume 待重试；此时不得再次写数据库。 */
  writeCommitted: boolean;
};

export type RowPatchCardDeps = {
  proposal: ConfirmableRecordProposal;
  write: (values: Record<string, unknown>) => Promise<RowPatchWriteResult>;
  resume: (decision: RowPatchResumeDecision) => Promise<void>;
  onChange?: (state: RowPatchCardState) => void;
};

export type RowPatchCard = ReturnType<typeof createRowPatchCard>;

export function createRowPatchCard(deps: RowPatchCardDeps) {
  const state: RowPatchCardState = {
    status: "pending",
    fields: deps.proposal.proposals.map((item) => ({
      field: item.field,
      currentValue: item.currentValue,
      suggestedValue: item.suggestedValue,
      basis: item.basis,
      confidence: item.confidence,
      accepted: true,
    })),
    error: null,
    writeCommitted: false,
  };

  function cloneState(): RowPatchCardState {
    return { ...state, fields: state.fields.map((field) => ({ ...field })) };
  }

  function emitChange(): void {
    deps.onChange?.(cloneState());
  }

  function setAccepted(field: string, accepted: boolean): void {
    if ((state.status !== "pending" && state.status !== "error") || state.writeCommitted) return;
    state.fields = state.fields.map((item) => (item.field === field ? { ...item, accepted } : item));
    emitChange();
  }

  /** 全部忽略 / 关闭卡片：记录零变更，以 write-rejected resume，run 走取消路径。 */
  async function rejectAll(): Promise<void> {
    if ((state.status !== "pending" && state.status !== "error") || state.writeCommitted) return;
    state.status = "rejecting";
    state.error = null;
    emitChange();

    await resumeTo({ kind: "write-rejected" }, "rejected");
  }

  /** resume 失败时回到 error 态保留卡片（写入可能已落库，重试 confirm 走 MERGE 幂等）。 */
  async function resumeTo(decision: RowPatchResumeDecision, doneStatus: "done" | "rejected"): Promise<void> {
    try {
      await deps.resume(decision);
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      emitChange();
      return;
    }
    state.status = doneStatus;
    state.error = null;
    emitChange();
  }

  async function confirm(): Promise<void> {
    if (state.status !== "pending" && state.status !== "error") return;
    if (state.writeCommitted) {
      state.status = "writing";
      state.error = null;
      emitChange();
      await resumeTo({ kind: "write-confirmed" }, "done");
      return;
    }
    const accepted = state.fields.filter((field) => field.accepted);
    if (!accepted.length) {
      await rejectAll();
      return;
    }

    state.status = "writing";
    state.error = null;
    emitChange();

    const values = Object.fromEntries(accepted.map((field) => [field.field, field.suggestedValue]));
    const result = await deps.write(values);
    if (!result.ok) {
      state.status = "error";
      state.error = result.message;
      emitChange();
      return;
    }

    state.writeCommitted = true;
    await resumeTo({ kind: "write-confirmed" }, "done");
  }

  return {
    snapshot: cloneState,
    setAccepted,
    confirm,
    rejectAll,
  };
}

/** 卡片上当前值 / 建议值的展示格式化：空值给 —，数组顿号连接，对象 JSON 序列化。 */
export function formatRowPatchValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map(formatRowPatchValue).join("、");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
