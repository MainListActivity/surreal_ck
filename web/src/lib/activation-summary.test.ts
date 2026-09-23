import { describe, expect, test } from "bun:test";
import { buildActivationSummaryPreview } from "./activation-summary";
import type { SurrealConn } from "./surreal";

function conn(counts: { user?: number; workbook?: number; fail?: "user" | "workbook" }): SurrealConn {
  return {
    async query(sql: string) {
      const table = sql.includes("FROM user") ? "user" : "workbook";
      if (counts.fail === table) throw new Error("query failed");
      return [{ count: counts[table] ?? 0 }];
    },
  } as unknown as SurrealConn;
}

describe("activation summary preview", () => {
  test("reports only allowlisted counts and leaves future v1 metrics unknown", async () => {
    const preview = await buildActivationSummaryPreview(
      conn({ user: 3, workbook: 2 }),
      new Date("2026-09-22T12:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(preview).toEqual({
      contractVersion: "1",
      period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "Asia/Shanghai" },
      stage: "activated",
      metrics: {
        members: { state: "completed", count: 3, source: "workspace.user" },
        workbooks: { state: "completed", count: 2, source: "workspace.workbook" },
        imports: { state: "unknown", count: null, source: "not_reported_v1" },
        reviews: { state: "unknown", count: null, source: "not_reported_v1" },
      },
      updatedAt: "2026-09-22T12:00:00.000Z",
      dedupeKey: "2026-09:v1",
    });
  });

  test("distinguishes incomplete from collection failure", async () => {
    expect((await buildActivationSummaryPreview(conn({ user: 1, workbook: 0 }))).stage).toBe("incomplete");
    const failed = await buildActivationSummaryPreview(conn({ user: 1, fail: "workbook" }));
    expect(failed.stage).toBe("failed");
    expect(failed.metrics.workbooks).toMatchObject({ state: "failed", count: null });
  });
});
