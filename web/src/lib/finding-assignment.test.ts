import { describe, expect, test } from "bun:test";
import type { SurrealConn, SurrealTransactionWriter } from "./surreal";
import { createFindingAssignment, reviewFindingAssignment, submitFindingAssignment } from "./finding-assignment";

function harness() {
  const assignments = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const findings = new Map([
    ["data_check_finding:f1", { id: "data_check_finding:f1", status: "pending", active_assignment: undefined }],
    ["data_check_finding:f2", { id: "data_check_finding:f2", status: "pending", active_assignment: undefined }],
  ]);
  let latestRun: Record<string, unknown> | undefined;
  let remaining: string[] = [];
  let seq = 0;
  const tx = {
    query: async (sql: string, bindings?: Record<string, unknown>) => {
      if (/FROM user/i.test(sql)) return [{ id: "user:a", kind: "human" }, { id: "user:r", kind: "human" }];
      if (/FROM data_check_run/i.test(sql)) return latestRun ? [latestRun] : [];
      if (/FROM data_check_finding WHERE id INSIDE/i.test(sql) && /last_run/i.test(sql)) return remaining.map((id) => ({ id }));
      if (/FROM data_check_finding WHERE id INSIDE/i.test(sql)) {
        const ids = new Set((bindings?.findings as unknown[]).map(String));
        return [...findings.values()].filter((finding) => ids.has(String(finding.id)));
      }
      if (/FROM finding_assignment_event/i.test(sql)) return events.has(String(bindings?.key)) ? [events.get(String(bindings?.key))!] : [];
      if (/FROM finding_assignment WHERE idempotency_key/i.test(sql)) return [...assignments.values()].filter((row) => row.idempotency_key === bindings?.key);
      if (/FROM finding_assignment WHERE id/i.test(sql)) return [...assignments.values()].filter((row) => row.id === String(bindings?.assignment));
      return [];
    },
    createRecord: async (table: string, data: Record<string, unknown>) => {
      if (table === "finding_assignment_event") {
        const row = { id: `${table}:e${events.size + 1}`, ...data };
        events.set(String(data.idempotency_key), row);
        return row;
      }
      const row = { id: `finding_assignment:a${++seq}`, ...data };
      assignments.set(String(row.id), row);
      return row;
    },
    updateRecord: async (id: string, patch: Record<string, unknown>) => {
      const target = assignments.get(id) ?? findings.get(id);
      if (!target) return { id, ...patch };
      Object.assign(target, patch);
      return { ...target };
    },
    deleteRecord: async () => ({}),
  } as SurrealTransactionWriter;
  const conn = { transaction: async <T>(run: (writer: SurrealTransactionWriter) => Promise<T>) => run(tx) } as SurrealConn;
  return { conn, assignments, events, findings, setLatestRun(row: Record<string, unknown>, unresolved: string[] = []) { latestRun = row; remaining = unresolved; } };
}

describe("真人派单与复核", () => {
  test("多问题只建一个活动派单，提交、退回、再提交、通过均幂等保留历史", async () => {
    const h = harness();
    const created = await createFindingAssignment(h.conn, {
      findingIds: ["data_check_finding:f1", "data_check_finding:f2"], assigneeId: "user:a", reviewerId: "user:r",
      dueAt: "2026-10-01T00:00:00Z", completionCondition: "补齐字段并关联材料", idempotencyKey: "create-1",
    });
    expect((await createFindingAssignment(h.conn, {
      findingIds: ["data_check_finding:f1"], assigneeId: "user:a", reviewerId: "user:r",
      dueAt: "2026-10-01T00:00:00Z", completionCondition: "重复", idempotencyKey: "create-1",
    })).id).toBe(created.id);
    const submitted = await submitFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: 1, note: "已补齐并关联材料", resourceIds: ["resource:x"], idempotencyKey: "submit-1",
    });
    expect(submitted.status).toBe("submitted");
    await expect(reviewFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: 2, decision: "approve", idempotencyKey: "review-too-early",
    })).rejects.toThrow("最新数据体检");
    const returned = await reviewFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: 2, decision: "return", reason: "材料说明不足", idempotencyKey: "return-1",
    });
    expect(returned.status).toBe("returned");
    const resubmitted = await submitFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: 3, note: "已补充", resourceIds: [], idempotencyKey: "submit-2",
    });
    h.setLatestRun({ id: "data_check_run:r2", status: "completed", stale: false, started_at: "9999-01-01T00:00:00Z" });
    const approved = await reviewFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: resubmitted.version, decision: "approve", idempotencyKey: "approve-1",
    });
    expect(approved.status).toBe("completed");
    expect([...h.findings.values()].every((finding) => finding.status === "closed")).toBe(true);
    expect(h.events.size).toBe(5);
    expect((await reviewFindingAssignment(h.conn, {
      assignmentId: created.id, expectedVersion: 4, decision: "approve", idempotencyKey: "approve-1",
    })).status).toBe("completed");
  });

  test("规则问题仍存在时必须填写例外理由，版本冲突零覆盖", async () => {
    const h = harness();
    const created = await createFindingAssignment(h.conn, {
      findingIds: ["data_check_finding:f1"], assigneeId: "user:a", reviewerId: "user:r",
      dueAt: "2026-10-01T00:00:00Z", completionCondition: "核验", idempotencyKey: "create-2",
    });
    const submitted = await submitFindingAssignment(h.conn, { assignmentId: created.id, expectedVersion: 1, note: "合法例外", resourceIds: [], idempotencyKey: "submit-x" });
    h.setLatestRun({ id: "data_check_run:r3", status: "completed", stale: false, started_at: "9999-01-01T00:00:00Z" }, ["data_check_finding:f1"]);
    await expect(reviewFindingAssignment(h.conn, { assignmentId: created.id, expectedVersion: submitted.version, decision: "approve", idempotencyKey: "approve-x" })).rejects.toThrow("例外必须填写理由");
    await expect(reviewFindingAssignment(h.conn, { assignmentId: created.id, expectedVersion: 1, decision: "return", reason: "退回", idempotencyKey: "bad-version" })).rejects.toThrow("他人更新");
    expect((await reviewFindingAssignment(h.conn, { assignmentId: created.id, expectedVersion: submitted.version, decision: "approve", reason: "确认属于合法多条申报", idempotencyKey: "approve-exception" })).status).toBe("completed");
  });
});
