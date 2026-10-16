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
 *
 * 上游工具把 label+key 归一到同一存储 key 后，proposals[] 可能出现重复 field；
 * Object.fromEntries 会静默 last-wins 折叠成单键。因此卡层在调用 write 前检测
 * accepted 条目中的重复 field（初始构建全接受即含提案自带重复）：发现即进入可见
 * error 态，不写库、不 resume；用户可取消勾选重复项之一后重试，或全部忽略。
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
/** 上游归一后同 key 多条的提案不能折叠写入：返回 accepted 中首个重复 field 名，无则 null。 */
function findDuplicateAcceptedField(fields: RowPatchFieldView[]): string | null {
  const seen = new Set<string>();
  for (const item of fields) {
    if (!item.accepted) continue;
    if (seen.has(item.field)) return item.field;
    seen.add(item.field);
  }
  return null;
}

function duplicateFieldMessage(field: string): string {
  return `提案存在重复字段「${field}」，已拒绝写入；请取消勾选重复项后重试，或全部忽略。`;
}

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

  // 初始 fields 全部接受，提案自带的重复 field 此刻即已处于 accepted；
  // 构建时立即进入可见 error 态，不等用户 confirm 才暴露。
  const initialDuplicate = findDuplicateAcceptedField(state.fields);
  if (initialDuplicate !== null) {
    state.status = "error";
    state.error = duplicateFieldMessage(initialDuplicate);
  }

  function cloneState(): RowPatchCardState {
    return { ...state, fields: state.fields.map((field) => ({ ...field })) };
  }

  function emitChange(): void {
    deps.onChange?.(cloneState());
  }

  /** 按条目索引切换：重复 field 的各条目可独立勾选，正常单 key 提案行为不变。 */
  function setAccepted(index: number, accepted: boolean): void {
    if ((state.status !== "pending" && state.status !== "error") || state.writeCommitted) return;
    state.fields = state.fields.map((item, i) => (i === index ? { ...item, accepted } : item));
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
    // 调用 write 前的硬闸：accepted 中仍有重复 field 时整笔拒绝，
    // 不写库、不 resume、writeCommitted 保持 false，避免 Object.fromEntries 静默折叠。
    const duplicateField = findDuplicateAcceptedField(state.fields);
    if (duplicateField !== null) {
      state.status = "error";
      state.error = duplicateFieldMessage(duplicateField);
      emitChange();
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
