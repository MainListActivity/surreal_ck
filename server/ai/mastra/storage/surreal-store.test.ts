import { beforeEach, describe, expect, test } from "bun:test";
import { SurrealMastraStore, SurrealMemoryStorage, SurrealObservabilityStorage } from "./surreal-store";

type AnyRow = Record<string, unknown> & { id?: unknown };

/**
 * 内存版 Surreal 会话替身：已 SIGNIN 到某个 workspace database 的调用者会话。
 * 按 UPSERT $id / SELECT ... FROM <table> 把行存进按表分桶的 Map，验证 memory / observability
 * 子 store 全部走注入会话而非已退役的 getLocalDb。
 */
function fakeSession() {
  const tables = new Map<string, Map<string, AnyRow>>();
  const bucket = (t: string) => tables.get(t) ?? tables.set(t, new Map()).get(t)!;
  const tableOf = (sql: string): string =>
    sql.match(/FROM\s+(\w+)/i)?.[1] ?? sql.match(/INTO\s+(\w+)/i)?.[1] ?? sql.match(/DELETE\s+(\w+)/i)?.[1] ?? "";

  return {
    tables,
    query: async (sql: string, params?: Record<string, unknown>) => {
      // UPSERT $id CONTENT {...} / UPSERT $id SET ...
      if (sql.includes("UPSERT $id")) {
        const id = String(params?.id);
        const t = id.split(":")[0] ?? "";
        bucket(t).set(id, { id, ...params });
        return [[]];
      }
      if (/^\s*SELECT/i.test(sql)) {
        const t = tableOf(sql);
        const rows = Array.from(bucket(t).values());
        let filtered = rows;
        if (params?.threadId && sql.includes("thread_id = $threadId")) {
          filtered = rows.filter((r) => r.threadId === params.threadId || r.thread_id === params.threadId);
        }
        if (sql.includes("count()")) return [filtered, [{ total: filtered.length }]];
        return [filtered, [{ total: filtered.length }]];
      }
      if (/^\s*DELETE/i.test(sql)) {
        const t = tableOf(sql);
        bucket(t).clear();
        return [[]];
      }
      return [[]];
    },
  };
}

describe("SurrealMemoryStorage（绑定调用者 surrealSession）", () => {
  let session: ReturnType<typeof fakeSession>;
  let storage: SurrealMemoryStorage;

  beforeEach(() => {
    session = fakeSession();
    storage = new SurrealMemoryStorage(() => session as never);
  });

  test("saveThread 走注入会话写入 memory_thread 表，而不是 getLocalDb", async () => {
    const createdAt = new Date("2026-05-09T08:00:00.000Z");
    await storage.saveThread({
      thread: { id: "thread-1", resourceId: "user:abc", title: "债权分析", createdAt, updatedAt: createdAt },
    });

    const memoryTable = Array.from(session.tables.keys()).find((t) => t.includes("memory"));
    expect(memoryTable).toBeDefined();
    expect(session.tables.get(memoryTable!)!.size).toBe(1);
  });

  test("没有任何子 store 依赖已退役的 getLocalDb（构造时不连任何全局连接）", () => {
    // 仅注入一个永不被调用的 resolver；构造不应抛错也不应触发全局连接。
    expect(() => new SurrealMemoryStorage(() => session as never)).not.toThrow();
  });
});

describe("SurrealObservabilityStorage（retention 走 env，不查 app_setting）", () => {
  test("createSpan 用注入会话写入，过期时间来自 env retention 天数", async () => {
    const session = fakeSession();
    const storage = new SurrealObservabilityStorage(() => session as never, { retentionDays: 7 });
    const now = Date.now();
    await storage.createSpan({
      span: {
        traceId: "t1",
        spanId: "s1",
        name: "root",
        startedAt: new Date(),
      } as never,
    });

    const spanTable = Array.from(session.tables.keys()).find((t) => t.includes("observability_span"));
    expect(spanTable).toBeDefined();
    const row = Array.from(session.tables.get(spanTable!)!.values())[0] as AnyRow;
    const content = row.content as { expires_at?: Date } | undefined;
    const expiresAt = (content?.expires_at ?? (row as { expires_at?: Date }).expires_at) as Date | undefined;
    expect(expiresAt).toBeInstanceOf(Date);
    // 7 天 retention：过期时间约在 now + 7d 附近（容忍几秒构造耗时）
    const expectedMs = now + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt!.getTime() - expectedMs)).toBeLessThan(60_000);
  });
});

describe("SurrealMastraStore（组合三个会话绑定子 store）", () => {
  test("用同一个注入 resolver 组合 memory / workflows / observability", () => {
    const session = fakeSession();
    const store = new SurrealMastraStore(() => session as never);
    expect(store.stores.memory).toBeInstanceOf(SurrealMemoryStorage);
    expect(store.stores.observability).toBeInstanceOf(SurrealObservabilityStorage);
    expect(store.stores.workflows).toBeDefined();
  });
});
