import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import type { GridColumnDef, ViewParams } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import type { LiveMessage } from "./surreal";
import {
  buildSelect,
  defineField,
  deleteRows,
  loadSheet,
  removeField,
  saveCells,
  subscribeLive,
  updateSheetColumns,
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

describe("record 字段（引用）边界：内存 string，交给 SDK 才包成 RecordId", () => {
  const refColumns: GridColumnDef[] = [
    { key: "name", label: "名称", fieldType: "text" },
    { key: "owner", label: "负责人", fieldType: "reference", referenceTable: "app_user" },
    { key: "parties", label: "当事人", fieldType: "reference", referenceTable: "ent_p", referenceMultiple: true },
  ];
  const refSheet: SheetRef = { tableName: "ent_claim", columns: refColumns };

  test("buildSelect：reference 列过滤值绑定成 RecordId，普通列仍是 string", () => {
    const view: ViewParams = {
      filters: [
        { key: "owner", op: "eq", value: "app_user:u1" },
        { key: "name", op: "eq", value: "app_user:notId" },
      ],
    };
    const built = buildSelect("ent_claim", view, refColumns, { limit: 50, start: 0 });
    expect(built.sql).toBe(
      "SELECT * FROM type::table($tb) WHERE owner = $f0 AND name = $f1 LIMIT 50 START 0",
    );
    expect(built.bindings.f0).toBeInstanceOf(StringRecordId);
    expect(String(built.bindings.f0)).toBe("app_user:u1");
    // 普通文本列即便值长得像 record id 也不包（它不是 record 字段）。
    expect(built.bindings.f1).toBe("app_user:notId");
  });

  test("buildSelect：reference 列 IN 过滤逐项包成 RecordId", () => {
    const view: ViewParams = { filters: [{ key: "parties", op: "in", value: ["ent_p:1", "ent_p:2"] }] };
    const built = buildSelect("ent_claim", view, refColumns, { limit: 50, start: 0 });
    const ids = built.bindings.f0 as unknown[];
    expect(ids).toBeArray();
    for (const id of ids) expect(id).toBeInstanceOf(StringRecordId);
    expect(ids.map(String)).toEqual(["ent_p:1", "ent_p:2"]);
  });

  test("saveCells：reference 写入值包成 RecordId（单值 + 多值数组）", async () => {
    const creates: Array<{ table: string; data: Record<string, unknown> }> = [];
    const conn = fakeConn({
      createRecord: (async (table: string, data: Record<string, unknown>) => {
        creates.push({ table, data });
        return { id: "ent_claim:new", ...data };
      }) as SurrealConn["createRecord"],
    });

    const result = await saveCells(conn, refSheet, [
      { values: { name: "案件A", owner: "app_user:u1", parties: ["ent_p:1", "ent_p:2"] } },
    ]);

    expect(result.ok).toBe(true);
    const data = creates[0].data;
    expect(data.name).toBe("案件A"); // 文本列原样
    expect(data.owner).toBeInstanceOf(StringRecordId);
    expect(String(data.owner)).toBe("app_user:u1");
    const parties = data.parties as unknown[];
    for (const p of parties) expect(p).toBeInstanceOf(StringRecordId);
    expect(parties.map(String)).toEqual(["ent_p:1", "ent_p:2"]);
  });

  test("loadSheet：SDK 读回的 RecordId 实例规整回 string 进内存", async () => {
    const conn = fakeConn({
      query: (async () => [
        {
          id: new RecordId("ent_claim", "abc"),
          name: "案件A",
          owner: new RecordId("app_user", "u1"),
          parties: [new RecordId("ent_p", "pa"), new RecordId("ent_p", "pb")],
        },
      ]) as SurrealConn["query"],
    });

    const rows = await loadSheet(conn, refSheet, {}, { limit: 100, start: 0 });

    expect(rows).toEqual([
      {
        id: "ent_claim:abc",
        values: { name: "案件A", owner: "app_user:u1", parties: ["ent_p:pa", "ent_p:pb"] },
      },
    ]);
    // 严格断言：内存里没有残留 RecordId 实例。
    expect(typeof rows[0].values.owner).toBe("string");
    expect((rows[0].values.parties as unknown[]).every((p) => typeof p === "string")).toBe(true);
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

describe("removeField — 管理员删字段走 REMOVE FIELD（DDL）", () => {
  test("拼出 REMOVE FIELD IF EXISTS 并经 conn.query 下发", async () => {
    const calls: string[] = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        calls.push(sql);
        return [];
      }) as SurrealConn["query"],
    });

    const result = await removeField(conn, "ent_claim", "note");

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["REMOVE FIELD IF EXISTS note ON TABLE ent_claim"]);
  });

  test("非法字段标识 / 系统保留字段：拒绝且不发任何 SQL", async () => {
    const calls: string[] = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        calls.push(sql);
        return [];
      }) as SurrealConn["query"],
    });

    for (const bad of ["note; REMOVE TABLE user", "id", "created_at", "大写X", ""]) {
      const result = await removeField(conn, "ent_claim", bad);
      expect(result.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe("updateSheetColumns — 字段集合 diff 落 DDL + column_defs 持久化", () => {
  test("保留/新增列逐个 OVERWRITE 定义，删掉的列 REMOVE，最后写回 sheet.column_defs", async () => {
    const sqls: string[] = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        sqls.push(sql);
        return [];
      }) as SurrealConn["query"],
      updateRecord: (async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return patch;
      }) as SurrealConn["updateRecord"],
    });

    const next: GridColumnDef[] = [
      { key: "name", label: "名称", fieldType: "text" },
      { key: "note", label: "备注", fieldType: "text" },
    ];
    const result = await updateSheetColumns(
      conn,
      { sheetId: "sheet:s1", tableName: "ent_claim", columns },
      next,
    );

    expect(result.ok).toBe(true);
    expect(sqls).toEqual([
      "DEFINE FIELD OVERWRITE name ON TABLE ent_claim TYPE option<string>",
      "DEFINE FIELD OVERWRITE note ON TABLE ent_claim TYPE option<string>",
      "REMOVE FIELD IF EXISTS amount ON TABLE ent_claim",
      "REMOVE FIELD IF EXISTS status ON TABLE ent_claim",
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("sheet:s1");
    const defs = updates[0].patch.column_defs as Array<Record<string, unknown>>;
    expect(defs.map((d) => d.key)).toEqual(["name", "note"]);
    expect(defs[0].field_type).toBe("text");
    if (result.ok) expect(result.columns.map((c) => c.key)).toEqual(["name", "note"]);
  });
});

describe("updateSheetColumns — 校验与权限失败路径", () => {
  test("空列表 / 重复 key：拒绝且不发任何 SQL", async () => {
    const sqls: string[] = [];
    const conn = fakeConn({
      query: (async (sql: string) => {
        sqls.push(sql);
        return [];
      }) as SurrealConn["query"],
    });
    const target = { sheetId: "sheet:s1", tableName: "ent_claim", columns };

    const empty = await updateSheetColumns(conn, target, []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("至少保留一个字段");

    const dup = await updateSheetColumns(conn, target, [
      { key: "name", label: "名称", fieldType: "text" },
      { key: "name", label: "重名", fieldType: "text" },
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain("字段标识重复");

    expect(sqls).toEqual([]);
  });

  test("普通成员无 DDL 权限：引擎拒绝 → 中文错误，column_defs 不写回", async () => {
    let persisted = false;
    const conn = fakeConn({
      query: (async () => {
        throw new Error("IAM error: Not enough permissions to perform this action");
      }) as SurrealConn["query"],
      updateRecord: (async (_id: string, patch: Record<string, unknown>) => {
        persisted = true;
        return patch;
      }) as SurrealConn["updateRecord"],
    });

    const result = await updateSheetColumns(
      conn,
      { sheetId: "sheet:s1", tableName: "ent_claim", columns },
      [{ key: "name", label: "名称", fieldType: "text" }],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("仅工作区管理员");
    expect(persisted).toBe(false);
  });
});
