import type { AiStructuredIntent, AiToolCallRecord } from "@surreal-ck/shared";

/**
 * 行分析「显式改字段」的提案补全（FV06）。
 *
 * 事故形态：用户点名了目标行、字段与目标值，模型只做了 findRecords / fetchRelatedRecords，
 * 读工具耗尽步数后就停了，于是收成「未生成字段补全提案」文案，没有提案卡。
 * 本模块只负责判定与保真：是否要补一次提案调用、补调用的提示词、补调用结果的建议值校验，
 * 以及未挂起时的明确原因。补调用本身由 agent-executor 在同一次请求内发起。
 */

/** 补充步骤唯一允许的提案工具。当前值由工具从已读到的记录读取，不由模型给出。 */
export const ROW_PROPOSAL_TOOL = "analyzeRow";

const LOCATE_TOOL = "findRecords";
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([LOCATE_TOOL, "fetchRelatedRecords"]);
/** findRecords 未传 limit 时的默认上限（与工具定义一致）。 */
const DEFAULT_LOCATE_LIMIT = 10;

/**
 * 子任务文本里写入动词之后的目标值，例如「填为「待复核」」「改为待复核」。
 * 只认写入动词，普通提问不会命中；值不含引号、标点与「的」，不做语义推断。
 */
const EXPLICIT_VALUE_PATTERN = /(?:改为|改成|填为|填写为|设为|设置为|更新为|修改为|写成|变更为)\s*[「“"]?([^「」“”"，。,；;\s的]+)/;

const NO_PROPOSAL_PREFIX = "未生成字段补全提案：";
const REASON_NOT_FOUND = `${NO_PROPOSAL_PREFIX}没有找到与目标行匹配的记录，请确认目标行的名称或编号、要修改的字段名后重试。`;
const REASON_NOT_PROVEN_UNIQUE = `${NO_PROPOSAL_PREFIX}无法确认目标行唯一（定位查询上限为 1），请放宽查询条件后重试。`;
const REASON_NO_FIELD = `${NO_PROPOSAL_PREFIX}没有为目标记录生成字段建议，请写明要修改的字段后重试。`;
const REASON_FIELD_REJECTED = `${NO_PROPOSAL_PREFIX}建议的字段未通过校验，见下方说明。`;
const reasonNotUnique = (hits: number) => `${NO_PROPOSAL_PREFIX}目标行不唯一（命中 ${hits} 条），请指定其中一条后重试。`;
const reasonValueMismatch = (value: string) => `${NO_PROPOSAL_PREFIX}模型给出的建议值与您指定的「${value}」不一致，已忽略。`;

export type SupplementPlan = { kind: "supplement"; sheetId: string; recordId: string; value: string };
export type ExplicitEditPlan = { kind: "skip" } | { kind: "blocked"; reason: string } | SupplementPlan;

type RowProposalIntent = Extract<AiStructuredIntent, { type: "row-patch-proposal" }>;

/** 子任务文本里点名的写入目标值；没有写入动词时返回 undefined。 */
export function explicitEditTargetValue(taskText: string): string | undefined {
  const value = EXPLICIT_VALUE_PATTERN.exec(taskText)?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * 判定本轮是否要补一次提案调用。以下条件同时满足才补：
 * - 子任务点名了目标值（写入动词加值）；
 * - 本轮只用了只读工具（findRecords / fetchRelatedRecords），没有提案或其它工具调用；
 * - 本轮最后一次 findRecords 唯一命中一条记录。
 * 命中 0 条或多条时不补调用，直接返回明确原因。
 */
export function planExplicitEditProposal(taskText: string, toolCalls: AiToolCallRecord[]): ExplicitEditPlan {
  const value = explicitEditTargetValue(taskText);
  if (!value) return { kind: "skip" };
  if (!toolCalls.every((call) => READ_ONLY_TOOLS.has(call.toolName))) return { kind: "skip" };
  const locate = [...toolCalls].reverse().find((call) => call.toolName === LOCATE_TOOL);
  if (!locate) return { kind: "skip" };

  const matches = asArray(asRecord(locate.result)?.matches);
  if (matches.length === 0) return { kind: "blocked", reason: REASON_NOT_FOUND };
  if (matches.length > 1) return { kind: "blocked", reason: reasonNotUnique(matches.length) };
  const args = asRecord(locate.args);
  const limit = typeof args?.limit === "number" ? args.limit : DEFAULT_LOCATE_LIMIT;
  if (limit <= 1) return { kind: "blocked", reason: REASON_NOT_PROVEN_UNIQUE };

  const sheetId = args?.sheetId;
  const recordId = asRecord(matches[0])?.id;
  if (typeof sheetId !== "string" || typeof recordId !== "string") return { kind: "skip" };
  return { kind: "supplement", sheetId, recordId, value };
}

/** 补充步骤的提示词：目标记录与目标值已由上一轮确定，只要求一次 analyzeRow。 */
export function buildSupplementPrompt(base: string, plan: SupplementPlan): string {
  return [
    base,
    "",
    "补充步骤（本次请求内唯一一次）：上一轮已用 findRecords 唯一定位到目标记录，但尚未生成字段补全提案。",
    `目标记录：sheetId=${plan.sheetId}，recordId=${plan.recordId}。`,
    `用户指定的目标值：「${plan.value}」。`,
    `请现在调用一次 ${ROW_PROPOSAL_TOOL}：`,
    "- workbookId 使用用户上下文快照中的值，sheetId 与 recordId 使用上面的值；",
    "- suggestions 只包含用户点名要修改的字段，suggestedValue 必须逐字等于用户指定的目标值；",
    "- basis 写「用户明确指定」，confidence 填 high；",
    "- 不要传 values 与 fields，当前值由工具从已读到的记录读取。",
  ].join("\n");
}

/**
 * 建议值保真：只保留 suggestedValue 与用户指定值逐字一致的建议。
 * 返回用于判定挂起与展示的副本，原始工具记录不改写，审计仍是模型的原始输出。
 */
export function keepValueMatchedProposals(call: AiToolCallRecord, value: string): AiToolCallRecord {
  const intent = readIntent(call);
  if (!isRowProposalIntent(intent)) return call;
  const proposals = proposalsOf(intent);
  const kept = proposals.filter((item) => String(item.suggestedValue).trim() === value);
  if (kept.length === proposals.length) return call;
  return { ...call, result: { ...asRecord(call.result), intent: { ...intent, proposals: kept } } };
}

/**
 * 补充步骤没有挂起时的明确原因：没有提案调用、建议字段被校验丢弃，或建议值与用户指定值不一致。
 * 字段被丢弃的明细由 agent-executor 的全丢弃说明补在后面。
 */
export function explainSupplementMiss(supplementCalls: AiToolCallRecord[], value: string): string {
  const intents = supplementCalls.map(readIntent).filter(isRowProposalIntent);
  const empty = intents.every((intent) => proposalsOf(intent).length === 0 && (intent.dropped ?? []).length === 0);
  if (empty) return REASON_NO_FIELD;
  if (intents.some((intent) => proposalsOf(intent).length > 0)) return reasonValueMismatch(value);
  return REASON_FIELD_REJECTED;
}

function readIntent(call: AiToolCallRecord): AiStructuredIntent | null {
  const intent = asRecord(asRecord(call.result)?.intent);
  return intent && typeof intent.type === "string" ? (intent as AiStructuredIntent) : null;
}

function isRowProposalIntent(intent: AiStructuredIntent | null): intent is RowProposalIntent {
  return intent?.type === "row-patch-proposal";
}

function proposalsOf(intent: RowProposalIntent): RowProposalIntent["proposals"] {
  return Array.isArray(intent.proposals) ? intent.proposals : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
