import { DateTime } from "surrealdb";
import { recordIdString, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";

export type FindingDispositionResult = { id: string; status: "not_applicable"; alreadyApplied: boolean };

export async function startFindingProcessing(
  conn: SurrealConn,
  input: { findingId: string; idempotencyKey: string },
): Promise<{ id: string; status: "processing"; alreadyApplied: boolean }> {
  return conn.transaction(async (tx) => {
    const existing = await tx.query<{ finding?: unknown }>(
      "SELECT finding FROM data_check_finding_event WHERE idempotency_key = $key LIMIT 1",
      { key: input.idempotencyKey },
    );
    if (existing.length) return { id: input.findingId, status: "processing" as const, alreadyApplied: true };
    const rows = await tx.query<{ id?: unknown; status?: unknown }>(
      "SELECT id, status FROM data_check_finding WHERE id = $finding LIMIT 1",
      { finding: toRecordId(input.findingId) },
    );
    if (!rows.length) throw new Error("问题不存在或无权处理");
    if (rows[0]?.status === "closed" || rows[0]?.status === "not_applicable") {
      throw new Error("该问题已结束，需由数据变化或复核流程重新打开");
    }
    await tx.updateRecord(input.findingId, { status: "processing" });
    await tx.createRecord("data_check_finding_event", {
      finding: toRecordId(input.findingId), kind: "processing_started",
      idempotency_key: input.idempotencyKey,
    });
    return { id: input.findingId, status: "processing" as const, alreadyApplied: false };
  });
}

export async function markFindingNotApplicable(
  conn: SurrealConn,
  input: { findingId: string; reason: string; idempotencyKey: string },
): Promise<FindingDispositionResult> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("标记不适用必须填写理由");
  if (reason.length > 500) throw new Error("不适用理由不能超过 500 个字符");
  return conn.transaction(async (tx) => {
    const existing = await tx.query<{ finding?: unknown }>(
      "SELECT finding FROM data_check_finding_event WHERE idempotency_key = $key LIMIT 1",
      { key: input.idempotencyKey },
    );
    if (existing.length) return {
      id: recordIdString(existing[0]?.finding) ?? input.findingId,
      status: "not_applicable" as const,
      alreadyApplied: true,
    };
    const findings = await tx.query<{ id?: unknown }>(
      "SELECT id FROM data_check_finding WHERE id = $finding LIMIT 1",
      { finding: toRecordId(input.findingId) },
    );
    if (!findings.length) throw new Error("问题不存在或无权处理");
    await tx.updateRecord(input.findingId, {
      status: "not_applicable",
      resolution_reason: reason,
      resolved_at: new DateTime(new Date().toISOString()),
    });
    await tx.createRecord("data_check_finding_event", {
      finding: toRecordId(input.findingId), kind: "marked_not_applicable",
      idempotency_key: input.idempotencyKey, reason,
    });
    return { id: input.findingId, status: "not_applicable" as const, alreadyApplied: false };
  });
}
