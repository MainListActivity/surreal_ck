import { describe, expect, test } from "bun:test";
import type { GridColumnDef, ViewParams } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import type { LiveMessage } from "./surreal";
import {
  buildSelect,
  defineField,
  deleteRows,
  loadSheet,
  saveCells,
  subscribeLive,
  type SheetRef,
} from "./workbook-data";

/** 仅实现数据层用到的 SurrealConn 窄接口。 */
function fakeConn(over: Partial<SurrealConn> = {}): SurrealConn {
  let conn: SurrealConn;
  conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: async () => [],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...over,
  } as SurrealConn;
  return conn;
}

const columns: GridColumnDef[] = [
  { key: "name", label: "名称", fieldType: "text" },
  { key: "amount", label: "金额", fieldType: "decimal" },
  { key: "status", label: "状态", fieldType: "single_select", options: ["新", "旧"] },
];

const sheet: SheetRef = { tableName: "ent_claim", columns };

describe("buildSelect — ViewParams 编译成参数化 SurrealQL", () => {
  test("无过滤无排序：纯 SELECT * 带分页", () => {
    const built = buildSelect("ent_claim", {}, columns, { limit: 100, start: 0 });
    expect(built.sql).toBe("SELECT * FROM type::table($tb) LIMIT 100 START 0");
    expect(built.bindings).toEqual({ tb: "ent_claim" });
  });

  test("eq 过滤参数化绑定，绝不内联值", () => {
    const view: ViewParams = { filters: [{ key: "name", op: "eq", value: "张三" }] };
    const built = buildSelect("ent_claim", view, columns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) WHERE name = $f0 LIMIT 50 START 0",
    );
    expect(built.bindings).toEqual({ tb: "ent_claim", f0: "张三" });
  });

  test("多过滤默认 AND，filterMode=or 时用 OR", () => {
    const view: ViewParams = {
      filters: [
        { key: "name", op: "contains", value: "李" },
        { key: "amount", op: "gte", value: 100 },
      ],
      filterMode: "or",
    };
    const built = buildSelect("ent_claim", view, columns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) WHERE name CONTAINS $f0 OR amount >= $f1 LIMIT 50 START 0",
    );
    expect(built.bindings).toEqual({ tb: "ent_claim", f0: "李", f1: 100 });
  });

  test("is_null / is_not_null 不产生 binding", () => {
    const view: ViewParams = { filters: [{ key: "amount", op: "is_null" }] };
    const built = buildSelect("ent_claim", view, columns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) WHERE amount IS NULL LIMIT 50 START 0",
    );
    expect(built.bindings).toEqual({ tb: "ent_claim" });
  });

  test("ORDER BY 多列", () => {
    const view: ViewParams = {
      sorts: [
        { key: "status", direction: "asc" },
        { key: "amount", direction: "desc" },
      ],
    };
    const built = buildSelect("ent_claim", view, columns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) ORDER BY status ASC, amount DESC LIMIT 50 START 0",
    );
  });

  test("过滤/排序引用未知列时静默丢弃（防注入：列名必须在 columnDefs 中）", () => {
    const view: ViewParams = {
      filters: [
        { key: "name", op: "eq", value: "ok" },
        { key: "evil; DROP TABLE x", op: "eq", value: "x" },
      ],
      sorts: [{ key: "nope", direction: "asc" }],
    };
    const built = buildSelect("ent_claim", view, columns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) WHERE name = $f0 LIMIT 50 START 0",
    );
    expect(built.bindings).toEqual({ tb: "ent_claim", f0: "ok" });
  });
});

describe("loadSheet — 直连 SELECT 并映射成 GridRow", () => {
  test("执行 buildSelect 出来的查询，剥掉系统字段后产出 {id, values}", async () => {
    const calls: Array<{ sql: string; bindings: unknown }> = [];
    const conn = fakeConn({
      query: (async (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return [
          {
            id: "ent_claim:abc",
            name: "张三",
            amount: 100,
            status: "新",
            created_at: "2026-01-01",
            created_by: "app_user:1",
            updated_at: "2026-01-02",
          },
        ];
      }) as SurrealConn["query"],
    });

    const rows = await loadSheet(conn, sheet, {}, { limit: 100, start: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe("SELECT * FROM type::table($tb) LIMIT 100 START 0");
    expect(rows).toEqual([
      { id: "ent_claim:abc", values: { name: "张三", amount: 100, status: "新" } },
    ]);
  });
});

describe("saveCells — 直连 UPDATE / CREATE，按列 coerce + validate", () => {
  test("带 id 的 patch → updateRecord（值按列类型 coerce）", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { id, ...patch };
      }) as SurrealConn["updateRecord"],
    });

    const result = await saveCells(conn, sheet, [
      { id: "ent_claim:abc", values: { amount: "200" } },
    ]);

    expect(updates).toEqual([{ id: "ent_claim:abc", patch: { amount: 200 } }]);
    expect(result.ok).toBe(true);
  });

  test("无 id 的 patch → createRecord", async () => {
    const creates: Array<{ table: string; data: Record<string, unknown> }> = [];
    const conn = fakeConn({
      createRecord: (async (table: string, data: Record<string, unknown>) => {
        creates.push({ table, data });
        return { id: "ent_claim:new", ...data };
      }) as SurrealConn["createRecord"],
    });

    const result = await saveCells(conn, sheet, [{ values: { name: "新行" } }]);

    expect(creates).toEqual([{ table: "ent_claim", data: { name: "新行" } }]);
    expect(result.ok).toBe(true);
  });

  test("多条 patch 在一个事务里执行；后续失败时回滚并返回 ok:false", async () => {
    const txUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    let committed = false;
    let cancelled = false;
    const conn = fakeConn({
      transaction: async (run) => {
        try {
          const result = await run({
            updateRecord: async (id: string, patch: Record<string, unknown>) => {
              txUpdates.push({ id, patch });
              if (id === "ent_claim:bad") throw new Error("second write failed");
              return { id, ...patch };
            },
            createRecord: async (_table: string, data: Record<string, unknown>) => data,
          });
          committed = true;
          return result;
        } catch (err) {
          cancelled = true;
          throw err;
        }
      },
    });

    const result = await saveCells(conn, sheet, [
      { id: "ent_claim:ok", values: { amount: "200" } },
      { id: "ent_claim:bad", values: { amount: "300" } },
    ]);

    expect(result.ok).toBe(false);
    expect(txUpdates).toEqual([
      { id: "ent_claim:ok", patch: { amount: 200 } },
      { id: "ent_claim:bad", patch: { amount: 300 } },
    ]);
    expect(committed).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("校验失败 → 返回 ok:false 且不下发任何写入", async () => {
    let wrote = false;
    let openedTransaction = false;
    const conn = fakeConn({
      updateRecord: (async () => {
        wrote = true;
        return {};
      }) as SurrealConn["updateRecord"],
      transaction: (async (run) => {
        openedTransaction = true;
        return run(conn);
      }) as SurrealConn["transaction"],
    });

    // amount 是 decimal，传非数字字符串触发 validate 报错
    const result = await saveCells(conn, sheet, [
      { id: "ent_claim:abc", values: { amount: "not-a-number" } },
    ]);

    expect(result.ok).toBe(false);
    expect(wrote).toBe(false);
    expect(openedTransaction).toBe(false);
    if (!result.ok) expect(result.message).toContain("amount");
  });
});

describe("deleteRows — 直连 DELETE by RecordId，事务内批量", () => {
  test("每个 id 走 deleteRecord，一个事务里执行", async () => {
    const deleted: string[] = [];
    let committed = false;
    const conn = fakeConn({
      transaction: async (run) => {
        const result = await run({
          updateRecord: async (_id, patch) => patch,
          createRecord: async (_table, data) => data,
          deleteRecord: (async (id: string) => {
            deleted.push(id);
            return {};
          }) as SurrealConn["deleteRecord"],
        });
        committed = true;
        return result;
      },
    });

    const result = await deleteRows(conn,["ent_claim:a", "ent_claim:b"]);

    expect(result.ok).toBe(true);
    expect(deleted).toEqual(["ent_claim:a", "ent_claim:b"]);
    expect(committed).toBe(true);
  });

  test("空 id 列表：不开事务，直接 ok", async () => {
    let openedTransaction = false;
    const conn = fakeConn({
      transaction: (async (run) => {
        openedTransaction = true;
        return run(conn);
      }) as SurrealConn["transaction"],
    });

    const result = await deleteRows(conn,[]);

    expect(result.ok).toBe(true);
    expect(openedTransaction).toBe(false);
  });

  test("权限不足：引擎拒绝 → 经 describeWriteError 翻译成中文", async () => {
    const conn = fakeConn({
      deleteRecord: (async () => {
        throw new Error("IAM error: Not enough permissions to perform this action");
      }) as SurrealConn["deleteRecord"],
    });

    const result = await deleteRows(conn,["ent_claim:a"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("权限");
  });
});

describe("subscribeLive — LIVE 变更分发到 upsert / remove", () => {
  test("订阅 sheet 的表，CREATE/UPDATE 走 upsert（GridRow），DELETE 走 remove（id）", async () => {
    let captured: ((msg: LiveMessage) => void) | null = null;
    let off = false;
    const conn = fakeConn({
      liveTable: (async (table: string, onMessage: (msg: LiveMessage) => void) => {
        expect(table).toBe("ent_claim");
        captured = onMessage;
        return () => {
          off = true;
        };
      }) as SurrealConn["liveTable"],
    });

    const upserts: unknown[] = [];
    const removes: string[] = [];
    const unsubscribe = await subscribeLive(conn, sheet, {
      onUpsert: (row) => upserts.push(row),
      onRemove: (id) => removes.push(id),
    });

    captured?.({ action: "CREATE", value: { id: "ent_claim:1", name: "甲", extra: "丢弃" } });
    captured?.({ action: "UPDATE", value: { id: "ent_claim:1", name: "乙" } });
    captured?.({ action: "DELETE", value: { id: "ent_claim:1" } });

    expect(upserts).toEqual([
      { id: "ent_claim:1", values: { name: "甲" } },
      { id: "ent_claim:1", values: { name: "乙" } },
    ]);
    expect(removes).toEqual(["ent_claim:1"]);

    unsubscribe();
    expect(off).toBe(true);
  });
});

describe("defineField — 管理员加字段走 DEFINE FIELD（DDL）", () => {
  test("text 字段：拼出带 type 的 DEFINE FIELD 并经 conn.query 下发", async () => {
    const calls: string[] = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        calls.push(sql);
        return [];
      }) as SurrealConn["query"],
    });

    const result = await defineField(conn, "ent_claim", {
      key: "note",
      label: "备注",
      fieldType: "text",
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("DEFINE FIELD note ON TABLE ent_claim TYPE option<string>");
  });

  test("required text 带 ASSERT 约束", async () => {
    const calls: string[] = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        calls.push(sql);
        return [];
      }) as SurrealConn["query"],
    });

    await defineField(conn, "ent_claim", {
      key: "title",
      label: "标题",
      fieldType: "text",
      required: true,
      constraints: { minLength: 1 },
    });

    expect(calls[0]).toBe(
      "DEFINE FIELD title ON TABLE ent_claim TYPE string ASSERT string::len($value) >= 1",
    );
  });

  test("普通成员无 DDL 权限：引擎拒绝 → 返回明确错误", async () => {
    const conn = fakeConn({
      query: (async () => {
        throw new Error("IAM error: Not enough permissions to perform this action");
      }) as SurrealConn["query"],
    });

    const result = await defineField(conn, "ent_claim", {
      key: "note",
      label: "备注",
      fieldType: "text",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("权限");
  });
});
