import { DateTime } from "surrealdb";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn, SurrealTransactionWriter } from "./surreal";

export type FindingAssignmentStatus = "active" | "submitted" | "returned" | "completed" | "cancelled";
export type FindingAssignment = {
  id: string;
  findingIds: string[];
  assigneeId: string;
  reviewerId: string;
  dueAt: string;
  completionCondition: string;
  status: FindingAssignmentStatus;
  version: number;
};

type AssignmentRow = Record<string, unknown>;

export async function loadActiveFindingAssignment(conn: SurrealConn, findingId: string): Promise<FindingAssignment | null> {
  const rows = await conn.query<AssignmentRow>(
    "SELECT * FROM finding_assignment WHERE $finding INSIDE findings AND status INSIDE [\"active\", \"submitted\", \"returned\"] ORDER BY updated_at DESC LIMIT 1",
    { finding: toRecordId(findingId) },
  );
  return rows[0] ? mapAssignment(rows[0]) : null;
}

export async function createFindingAssignment(conn: SurrealConn, input: {
  findingIds: string[]; assigneeId: string; reviewerId: string; dueAt: string;
  completionCondition: string; idempotencyKey: string;
}): Promise<FindingAssignment> {
  const findingIds = [...new Set(input.findingIds)];
  if (!findingIds.length) throw new Error("至少选择一个体检问题");
  if (!input.completionCondition.trim()) throw new Error("必须填写完成条件");
  return conn.transaction(async (tx) => {
    const existing = await tx.query<AssignmentRow>("SELECT * FROM finding_assignment WHERE idempotency_key = $key LIMIT 1", { key: input.idempotencyKey });
    if (existing[0]) return mapAssignment(existing[0]);
    const users = await tx.query<{ id?: unknown; kind?: unknown }>(
      "SELECT id, kind FROM user WHERE id INSIDE $users",
      { users: [toRecordId(input.assigneeId), toRecordId(input.reviewerId)] },
    );
    if (users.length !== 2 || users.some((user) => user.kind !== "human")) throw new Error("负责人和复核人必须是当前工作区真人成员");
    const findings = await tx.query<{ id?: unknown; active_assignment?: unknown }>(
      "SELECT id, active_assignment FROM data_check_finding WHERE id INSIDE $findings",
      { findings: findingIds.map(toRecordId) },
    );
    if (findings.length !== findingIds.length) throw new Error("部分问题不存在或无权访问");
    if (findings.some((finding) => finding.active_assignment != null)) throw new Error("所选问题已有活动派单");
    const created = single(await tx.createRecord<AssignmentRow>("finding_assignment", {
      findings: findingIds.map(toRecordId), assignee: toRecordId(input.assigneeId), reviewer: toRecordId(input.reviewerId),
      due_at: new DateTime(new Date(input.dueAt).toISOString()), completion_condition: input.completionCondition.trim(),
      status: "active", version: 1, idempotency_key: input.idempotencyKey,
    }));
    const assignmentId = requiredId(created);
    for (const findingId of findingIds) await updateRequired(tx, findingId, {
      active_assignment: toRecordId(assignmentId), handlers: [toRecordId(input.assigneeId), toRecordId(input.reviewerId)], status: "processing",
    });
    await appendEvent(tx, assignmentId, "created", `${input.idempotencyKey}:created`, undefined);
    return mapAssignment(created);
  });
}

export async function submitFindingAssignment(conn: SurrealConn, input: {
  assignmentId: string; expectedVersion: number; note: string; resourceIds: string[]; idempotencyKey: string;
}): Promise<FindingAssignment> {
  if (!input.note.trim()) throw new Error("提交处理必须填写说明");
  return mutateAssignment(conn, input.assignmentId, input.idempotencyKey, async (tx, row) => {
    assertVersion(row, input.expectedVersion);
    if (row.status !== "active" && row.status !== "returned") throw new Error("派单当前状态不能提交");
    const now = new DateTime(new Date().toISOString());
    const updated = single(await tx.updateRecord<AssignmentRow>(input.assignmentId, {
      status: "submitted", submission_note: input.note.trim(), resource_refs: input.resourceIds.map(toRecordId),
      submitted_at: now, version: input.expectedVersion + 1,
    }));
    for (const finding of recordArray(row.findings)) await updateRequired(tx, finding, { status: "pending_review" });
    await appendEvent(tx, input.assignmentId, "submitted", input.idempotencyKey, input.note.trim());
    return updated;
  });
}

export async function reviewFindingAssignment(conn: SurrealConn, input: {
  assignmentId: string; expectedVersion: number; decision: "approve" | "return";
  reason?: string; idempotencyKey: string;
}): Promise<FindingAssignment> {
  return mutateAssignment(conn, input.assignmentId, input.idempotencyKey, async (tx, row) => {
    assertVersion(row, input.expectedVersion);
    if (row.status !== "submitted") throw new Error("派单尚未进入待复核");
    const findings = recordArray(row.findings);
    if (input.decision === "approve") {
      const latestRuns = await tx.query<{ id?: unknown; status?: unknown; stale?: unknown; started_at?: unknown }>(
        "SELECT id, status, stale, started_at FROM data_check_run ORDER BY started_at DESC LIMIT 1",
      );
      const latest = latestRuns[0];
      if (!latest || latest.status !== "completed" || latest.stale === true || String(latest.started_at) <= String(row.submitted_at ?? "")) {
        throw new Error("通过前必须在处理提交后完成一次最新数据体检");
      }
      const remaining = await tx.query<{ id?: unknown }>(
        "SELECT id FROM data_check_finding WHERE id INSIDE $findings AND last_run = $run",
        { findings: findings.map(toRecordId), run: latest.id },
      );
      if (remaining.length && !input.reason?.trim()) throw new Error("规则问题仍存在，通过例外必须填写理由");
    } else if (!input.reason?.trim()) throw new Error("退回必须填写理由");
    const completed = input.decision === "approve";
    const updated = single(await tx.updateRecord<AssignmentRow>(input.assignmentId, {
      status: completed ? "completed" : "returned", review_reason: input.reason?.trim(),
      reviewed_at: new DateTime(new Date().toISOString()), version: input.expectedVersion + 1,
    }));
    for (const finding of findings) await updateRequired(tx, finding, completed
      ? { status: "closed" }
      : { status: "processing" });
    await appendEvent(tx, input.assignmentId, completed ? "approved" : "returned", input.idempotencyKey, input.reason?.trim());
    return updated;
  });
}

async function mutateAssignment(
  conn: SurrealConn, assignmentId: string, idempotencyKey: string,
  mutate: (tx: SurrealTransactionWriter, row: AssignmentRow) => Promise<AssignmentRow>,
): Promise<FindingAssignment> {
  return conn.transaction(async (tx) => {
    const prior = await tx.query<{ assignment?: unknown }>("SELECT assignment FROM finding_assignment_event WHERE idempotency_key = $key LIMIT 1", { key: idempotencyKey });
    if (prior[0]) {
      const rows = await tx.query<AssignmentRow>("SELECT * FROM finding_assignment WHERE id = $assignment LIMIT 1", { assignment: toRecordId(assignmentId) });
      if (!rows[0]) throw new Error("派单不存在或无权访问");
      return mapAssignment(rows[0]);
    }
    const rows = await tx.query<AssignmentRow>("SELECT * FROM finding_assignment WHERE id = $assignment LIMIT 1", { assignment: toRecordId(assignmentId) });
    if (!rows[0]) throw new Error("派单不存在或无权访问");
    return mapAssignment(await mutate(tx, rows[0]));
  });
}

async function appendEvent(tx: SurrealTransactionWriter, assignmentId: string, kind: string, key: string, note?: string) {
  await tx.createRecord("finding_assignment_event", { assignment: toRecordId(assignmentId), kind, idempotency_key: key, note });
}

function mapAssignment(row: AssignmentRow): FindingAssignment {
  return {
    id: requiredId(row), findingIds: recordArray(row.findings), assigneeId: recordValueToString(row.assignee) ?? "",
    reviewerId: recordValueToString(row.reviewer) ?? "", dueAt: String(row.due_at ?? ""),
    completionCondition: String(row.completion_condition ?? ""), status: row.status as FindingAssignmentStatus,
    version: Number(row.version ?? 1),
  };
}
function single<T>(value: T | T[]): T { return Array.isArray(value) ? value[0]! : value; }
function requiredId(row: AssignmentRow): string { const id = recordValueToString(row.id); if (!id) throw new Error("写入后未返回派单标识"); return id; }
function recordArray(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => recordValueToString(item) ?? []) : []; }
function assertVersion(row: AssignmentRow, expected: number) { if (Number(row.version) !== expected) throw new Error("派单已被他人更新，请刷新后重试"); }
async function updateRequired(tx: SurrealTransactionWriter, id: string, patch: Record<string, unknown>) {
  const value = await tx.updateRecord<AssignmentRow>(id, patch);
  const row = single(value);
  if (!row || !recordValueToString(row.id)) throw new Error("记录更新被权限策略拒绝");
  return row;
}
