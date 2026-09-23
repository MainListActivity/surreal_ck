import { describe, expect, test } from "bun:test";
import type { SurrealConn, SurrealTransactionWriter } from "./surreal";
import { markFindingNotApplicable, startFindingProcessing } from "./finding-repair";

describe("体检问题不适用处理", () => {
  test("必须填写理由，事务更新问题与审计，重复确认不追加", async () => {
    const events = new Map<string, Record<string, unknown>>();
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const tx = {
      query: async (sql: string, bindings?: Record<string, unknown>) => {
        if (/finding_event/i.test(sql)) return events.has(String(bindings?.key)) ? [events.get(String(bindings?.key))!] : [];
        return [{ id: "data_check_finding:f1", status: "pending" }];
      },
      updateRecord: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id, ...patch }; },
      createRecord: async (_table: string, data: Record<string, unknown>) => {
        events.set(String(data.idempotency_key), { id: "data_check_finding_event:e1", ...data });
        return data;
      },
      deleteRecord: async () => ({}),
    } as SurrealTransactionWriter;
    const conn = { transaction: async (run: (writer: SurrealTransactionWriter) => Promise<unknown>) => run(tx) } as SurrealConn;

    await expect(markFindingNotApplicable(conn, { findingId: "data_check_finding:f1", reason: " ", idempotencyKey: "k1" })).rejects.toThrow("必须填写理由");
    expect(await startFindingProcessing(conn, { findingId: "data_check_finding:f1", idempotencyKey: "processing-1" })).toMatchObject({ status: "processing", alreadyApplied: false });
    expect(await startFindingProcessing(conn, { findingId: "data_check_finding:f1", idempotencyKey: "processing-1" })).toMatchObject({ status: "processing", alreadyApplied: true });
    const first = await markFindingNotApplicable(conn, { findingId: "data_check_finding:f1", reason: "合法的多条申报", idempotencyKey: "k1" });
    const second = await markFindingNotApplicable(conn, { findingId: "data_check_finding:f1", reason: "合法的多条申报", idempotencyKey: "k1" });

    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(updates).toHaveLength(2);
    expect(events.size).toBe(2);
  });
});
