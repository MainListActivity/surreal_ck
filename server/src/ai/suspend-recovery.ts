/**
 * suspended run 的决策载荷恢复（PG-1 修复）。
 *
 * workflow suspend 时 Mastra 把 suspendPayload 持久化在 `workflow_run.state.context`
 * 的 suspended step result 里（workspace db、owner PERMISSIONS 已隔离）——它是
 * 「run 持久态」的权威来源。SSE 中断 / 页面刷新后，recover 端点从这里把等待中的
 * 用户决策载荷还原成 `WorkflowSuspendedEvent` 交给前端重渲染确认卡；
 * 决策本身仍走既有 resume 契约，不削弱显式确认语义。
 */
import type { Surreal } from "surrealdb";
import {
  WorkflowSuspendedEventSchema,
  type CandidateOption,
  type WorkflowSuspendedEvent,
} from "@surreal-ck/shared";

type Session = Pick<Surreal, "query">;

export type SuspendedRunDecision = {
  /** workflow_run.status 列原值（Mastra snapshot.status）。 */
  status: string;
  /** 处于 suspended 且带可还原 suspendPayload 时给出的事件；否则 undefined。 */
  suspended?: WorkflowSuspendedEvent;
};

type StepResultLike = {
  status?: unknown;
  suspendPayload?: unknown;
  suspendedAt?: unknown;
};

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStatementRows<T>(queryResult: unknown): T[] {
  if (!Array.isArray(queryResult)) return [];
  const first = queryResult[0];
  return Array.isArray(first) ? (first as T[]) : [];
}

function candidates(value: unknown): CandidateOption[] | undefined {
  return Array.isArray(value) ? (value as CandidateOption[]) : undefined;
}

/** 持久化 suspendPayload（SuspendPayloadSchema 形状）→ 面向前端的 WorkflowSuspendedEvent。 */
function suspendedEventFromPayload(runId: string, payload: unknown): WorkflowSuspendedEvent | undefined {
  const p = asRecord(payload);
  if (!p) return undefined;
  switch (p.kind) {
    case "await-write-confirm":
      return { kind: "await-write-confirm", runId, intent: p.intent as never };
    case "ambiguous":
      return { kind: "ambiguous-candidates", runId, candidates: candidates(p.candidates) as never,
        truncated: p.truncated === true ? true : undefined };
    case "resource-candidates":
      return { kind: "resource-candidates", runId, candidates: candidates(p.candidates) as never,
        truncated: p.truncated === true ? true : undefined };
    case "manual-research":
      return { kind: "manual-research", runId, sessionId: String(p.sessionId ?? ""),
        workspaceId: String(p.workspaceId ?? ""), query: String(p.query ?? ""), resourceType: String(p.resourceType ?? "") };
    case "authorization_changed":
      // authorization/resourceIds 留在 snapshot 里供 resume 消费；事件只需呈现与继续入口。
      return { kind: "authorization_changed", runId, query: String(p.query ?? ""),
        message: "授权已变化。请重新检索，或继续使用当前合法材料。" };
    default:
      return undefined;
  }
}

function suspendedResults(step: unknown, sink: StepResultLike[]): void {
  for (const item of Array.isArray(step) ? step : [step]) {
    const record = asRecord(item);
    if (record?.status === "suspended" && record.suspendPayload != null) {
      sink.push(record as StepResultLike);
    }
  }
}

/**
 * 在 snapshot.context（stepId → SerializedStepResult）里定位最近的 suspended step result。
 * 先用 Mastra 的 suspendedPaths 索引精确定位（dountil 里 stepId 可重复，值可为数组），
 * 索引缺失时退回全量扫描。
 */
export function extractSuspendedPayload(state: unknown): unknown {
  // 兼容历史行：state 可能以 JSON 字符串形态存储（storage parseState 同此约定）。
  const root = asRecord(typeof state === "string" ? tryParse(state) : state);
  const context = asRecord(root?.context);
  if (!context) return undefined;
  const suspended: StepResultLike[] = [];
  const suspendedPaths = asRecord(root?.suspendedPaths);
  const indexed = suspendedPaths ? Object.keys(suspendedPaths) : [];
  for (const stepId of indexed) {
    if (stepId in context) suspendedResults(context[stepId], suspended);
  }
  if (!suspended.length) {
    for (const value of Object.values(context)) {
      suspendedResults(value, suspended);
    }
  }
  suspended.sort((a, b) => Number(a.suspendedAt ?? 0) - Number(b.suspendedAt ?? 0));
  return suspended.at(-1)?.suspendPayload;
}

/**
 * 以调用者会话读本人 workflow_run（owner PERMISSIONS + 显式 owner 谓词双保险）。
 * 返回 undefined：该 run 对调用者不可见或不存在（不泄露他人 run 的存在）。
 */
export async function loadSuspendedRunDecision(session: Session, runId: string): Promise<SuspendedRunDecision | undefined> {
  const rows = firstStatementRows<{ status?: unknown; state?: unknown }>(await session.query(
    `SELECT status, state FROM workflow_run WHERE run_id = $runId AND workflow_name = "routerWorkflow"
      AND owner_user = fn::current_user() AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE
      LIMIT 1`,
    { runId },
  ));
  const row = rows[0];
  if (!row) return undefined;
  const status = typeof row.status === "string" ? row.status : "";
  if (status !== "suspended") return { status };
  const event = suspendedEventFromPayload(runId, extractSuspendedPayload(row.state));
  const parsed = event ? WorkflowSuspendedEventSchema.safeParse(event) : undefined;
  return parsed?.success ? { status, suspended: parsed.data } : { status };
}
