import { describe, expect, test } from "bun:test";
import { SurrealFunnelCountStore } from "./store";

/** _system 计数行只有四字段（返工 B3）：event/day/workspace_key/count，不读 updated_at。 */
describe("SurrealFunnelCountStore", () => {
  test("只投影四字段：不返回 updatedAt，查询也不选择 updated_at", async () => {
    const queries: string[] = [];
    const store = new SurrealFunnelCountStore(
      async () => ({
        async query(sql: string) {
          queries.push(sql);
          return [[{
            event: "first_login",
            day: "2026-10-29",
            workspace_key: "ab12",
            count: 3,
            // 历史/外部行即使带 updated_at 也不进入响应。
            updated_at: "2026-10-29T00:00:00Z",
          }]];
        },
      }),
      "main",
    );

    const rows = await store.list({ event: "first_login", day: "2026-10-29", limit: 10 });

    expect(rows).toEqual([{ event: "first_login", day: "2026-10-29", workspaceKey: "ab12", count: 3 }]);
    expect(rows[0]).not.toHaveProperty("updatedAt");
    expect(queries[0]).not.toContain("updated_at");
    expect(queries[0]).toContain("SELECT event, day, workspace_key, count FROM funnel_event_count");
  });

  test("缺字段的行被丢弃，不构造半行", async () => {
    const store = new SurrealFunnelCountStore(
      async () => ({
        async query() {
          return [[{ event: "first_login", day: "2026-10-29", count: 1 }]];
        },
      }),
      "main",
    );
    expect(await store.list({})).toEqual([]);
  });

  test("summarize 在数据库内聚合，只返回总量与工作区数", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const store = new SurrealFunnelCountStore(
      async () => ({
        async query(sql: string, params?: Record<string, unknown>) {
          calls.push({ sql, params });
          return [[{
            workspace_count: 501,
            total_count: 1002,
            workspace_key: "must-not-escape",
          }]];
        },
      }),
      "main",
    );

    const summary = await store.summarize({ event: "first_login", day: "2026-10-29" });

    expect(summary).toEqual({ totalCount: 1002, workspaceCount: 501 });
    expect(summary).not.toHaveProperty("workspaceKey");
    expect(calls[0]?.sql).toContain("count() AS workspace_count, math::sum(count) AS total_count");
    expect(calls[0]?.sql).toContain("GROUP ALL");
    expect(calls[0]?.params).toEqual({ event: "first_login", day: "2026-10-29" });
  });

  test("summarize 空结果按零处理", async () => {
    const store = new SurrealFunnelCountStore(
      async () => ({ async query() { return [[]]; } }),
      "main",
    );
    expect(await store.summarize({ event: "first_login", day: "2026-10-29" }))
      .toEqual({ totalCount: 0, workspaceCount: 0 });
  });

  test("summarize 非法聚合行直接失败，不构造半行", async () => {
    const store = new SurrealFunnelCountStore(
      async () => ({ async query() { return [[{ workspace_count: 1 }]]; } }),
      "main",
    );
    await expect(store.summarize({ event: "first_login", day: "2026-10-29" }))
      .rejects.toThrow("funnel summary aggregate malformed");
  });
});
