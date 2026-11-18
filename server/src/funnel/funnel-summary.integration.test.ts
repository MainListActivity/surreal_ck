import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { buildFunnelSummary } from "./summary";
import { SurrealFunnelCountStore } from "./store";

/**
 * 用公司 SurrealDB fork（SURREAL_BINARY，CI 由 Quality gate 安装）起一个独立
 * memory 实例，写入合成日汇总：501 个工作区的计数必须完整进入总量（旧逐行接口
 * 的 500 行上限不再适用），并验证两个低样本条件、阈值边界、空窗与事件隔离。
 */
const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;

const NAMESPACE = "funnel_summary_test";

async function waitReady(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // 实例尚未监听。
    }
    await Bun.sleep(50);
  }
  throw new Error("surreal fork did not become ready");
}

function rows(count: number, event: string, day: string, countValue: number) {
  return Array.from({ length: count }, (_, index) => ({
    event,
    day,
    workspace_key: `${day}-${event}-${index}`,
    count: countValue,
  }));
}

describe("funnel summary — 公司 fork 真机聚合", () => {
  test("501 个工作区聚合准确，低样本/阈值/空窗可区分", async () => {
    const port = 30000 + Math.floor(Math.random() * 10_000);
    const password = crypto.randomUUID();
    const proc = Bun.spawn([
      surrealBinary,
      "start",
      "--allow-all",
      "--bind", `127.0.0.1:${port}`,
      "--user", "test",
      "--pass", password,
      "memory",
    ], { stdout: "ignore", stderr: "ignore" });
    const db = new Surreal();
    try {
      await waitReady(port);
      await db.connect(`ws://127.0.0.1:${port}/rpc`);
      await db.signin({ username: "test", password });
      // 汇总读取固定走 _system，与被测 store 的会话选择一致。
      const database = "_system";
      await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${NAMESPACE}; USE NS ${NAMESPACE}; DEFINE DATABASE IF NOT EXISTS ${database};`).collect();
      await db.use({ namespace: NAMESPACE, database });
      await db.query(await Bun.file(new URL(
        "../../../shared/sql/system/040-funnel-event-count.surql",
        import.meta.url,
      )).text()).collect();

      // 501 个工作区 × 2 次 = 1002；同一天另一事件 600 个工作区用于验证事件隔离。
      await db.query("INSERT INTO funnel_event_count $rows;", { rows: rows(501, "first_login", "2026-10-29", 2) }).collect();
      await db.query("INSERT INTO funnel_event_count $rows;", { rows: rows(600, "template_created", "2026-10-29", 1) }).collect();
      // 低样本：总量 4（<5）与工作区 2（<3）分别触发抑制。
      await db.query("INSERT INTO funnel_event_count $rows;", { rows: rows(4, "first_login", "2026-10-30", 1) }).collect();
      await db.query("INSERT INTO funnel_event_count $rows;", { rows: rows(2, "first_login", "2026-10-31", 10) }).collect();
      // 恰好等于阈值：总量 5、工作区 3。
      await db.query("INSERT INTO funnel_event_count $rows;", {
        rows: rows(3, "first_login", "2026-11-01", 0).map((row, index) => ({ ...row, count: index === 0 ? 1 : 2 })),
      }).collect();

      const store = new SurrealFunnelCountStore(async (requestedDatabase, requestedNamespace) => {
        await db.use({ namespace: requestedNamespace, database: requestedDatabase });
        return { query: (sql: string, params?: Record<string, unknown>) => db.query(sql, params).collect() };
      }, NAMESPACE);

      const big = buildFunnelSummary("first_login", "2026-10-29",
        await store.summarize({ event: "first_login", day: "2026-10-29" }));
      expect(big).toMatchObject({ state: "reported", totalCount: 1002, workspaceCount: 501 });

      const isolated = await store.summarize({ event: "template_created", day: "2026-10-29" });
      expect(isolated).toEqual({ totalCount: 600, workspaceCount: 600 });

      const totalLow = buildFunnelSummary("first_login", "2026-10-30",
        await store.summarize({ event: "first_login", day: "2026-10-30" }));
      expect(totalLow).toMatchObject({ state: "suppressed", totalCount: null, workspaceCount: null });

      const workspaceLow = buildFunnelSummary("first_login", "2026-10-31",
        await store.summarize({ event: "first_login", day: "2026-10-31" }));
      expect(workspaceLow).toMatchObject({ state: "suppressed", totalCount: null, workspaceCount: null });

      const boundary = buildFunnelSummary("first_login", "2026-11-01",
        await store.summarize({ event: "first_login", day: "2026-11-01" }));
      expect(boundary).toMatchObject({ state: "reported", totalCount: 5, workspaceCount: 3 });

      const empty = buildFunnelSummary("first_login", "2026-11-02",
        await store.summarize({ event: "first_login", day: "2026-11-02" }));
      expect(empty).toMatchObject({ state: "empty", totalCount: 0, workspaceCount: 0 });

      // 汇总响应只含聚合值与固定元数据，不含任何工作区标识。
      const serialized = JSON.stringify([big, isolated, totalLow, workspaceLow, boundary, empty]);
      expect(serialized).not.toContain("workspace_key");
      expect(serialized).not.toContain("2026-10-29-first_login-0");
      expect(serialized).not.toContain("2026-10-29-template_created-0");
    } finally {
      await db.close().catch(() => undefined);
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});