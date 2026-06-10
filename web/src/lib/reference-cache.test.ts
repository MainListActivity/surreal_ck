import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { SurrealConn } from "./surreal";
import {
  collectReferenceIdsFromValues,
  isLikelyRecordId,
  listReferenceTargets,
  resolveReferences,
  searchReferenceCandidates,
} from "./reference-cache";

type QueryCall = { sql: string; bindings: unknown };

/** fake conn：按 $tb 绑定返回对应表的记录；记录所有 query。 */
function setup(byTable: Record<string, Array<Record<string, unknown>>>) {
  const calls: QueryCall[] = [];
  const conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: (async (sql: string, bindings?: Record<string, unknown>) => {
      calls.push({ sql, bindings });
      const tb = bindings?.tb as string | undefined;
      const rows = tb ? byTable[tb] ?? [] : [];
      // WHERE id INSIDE $ids：$ids 现在是 RecordId（StringRecordId）数组——
      // fake 里按其 string 形态过滤，模拟引擎对 record 字段的相等比较。
      const ids = bindings?.ids as Array<{ toString(): string }> | undefined;
      if (ids) {
        const wanted = new Set(ids.map((id) => String(id)));
        return rows.filter((r) => wanted.has(String(r.id)));
      }
      return rows;
    }) as SurrealConn["query"],
    liveTable: (async () => () => {}) as SurrealConn["liveTable"],
    updateRecord: (async () => ({})) as SurrealConn["updateRecord"],
    createRecord: (async () => ({})) as SurrealConn["createRecord"],
    deleteRecord: (async () => ({})) as SurrealConn["deleteRecord"],
    transaction: (async (run: (tx: SurrealConn) => Promise<unknown>) => run(conn)) as SurrealConn["transaction"],
  } as SurrealConn;
  return { conn, calls };
}

describe("isLikelyRecordId", () => {
  test("table:id 形态为真，其余为假", () => {
    expect(isLikelyRecordId("app_user:abc")).toBe(true);
    expect(isLikelyRecordId("ent_claim:1")).toBe(true);
    expect(isLikelyRecordId("noColon")).toBe(false);
    expect(isLikelyRecordId(":leading")).toBe(false);
    expect(isLikelyRecordId("trailing:")).toBe(false);
  });
});

describe("collectReferenceIdsFromValues — 扁平化提取引用 id", () => {
  test("单值 + 数组都收集，剔除非字符串/空", () => {
    const ids = collectReferenceIdsFromValues(
      { owner: "app_user:u1", parties: ["ent_p:1", "ent_p:2"], note: "x", empty: null },
      ["owner", "parties", "empty"],
    );
    expect(ids).toEqual(["app_user:u1", "ent_p:1", "ent_p:2"]);
  });
});

describe("resolveReferences — 直连按表分组解析展示值", () => {
  test("按目标表分组各发一条 SELECT，WHERE id INSIDE $ids 参数化", async () => {
    const { conn, calls } = setup({
      app_user: [{ id: "app_user:u1", name: "张三" }],
      ent_claim: [{ id: "ent_claim:c1", name: "案件A" }],
    });

    const items = await resolveReferences(conn, ["app_user:u1", "ent_claim:c1"]);

    // 两张表 → 两条 query，都带 $tb + $ids 绑定，绝不内联
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.sql).toMatch(/FROM type::table\(\$tb\)/);
      expect(c.sql).toMatch(/WHERE id INSIDE \$ids/);
      // id 是 record 字段：$ids 须是 RecordId 数组，不能是裸 string，否则 INSIDE 比较查不到。
      const ids = (c.bindings as { ids: unknown[] }).ids;
      expect(ids).toBeArray();
      for (const id of ids) expect(id).toBeInstanceOf(StringRecordId);
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("app_user:u1")?.primaryLabel).toBe("张三");
    expect(byId.get("app_user:u1")?.table).toBe("app_user");
    expect(byId.get("ent_claim:c1")?.primaryLabel).toBe("案件A");
  });

  test("displayKey 回退链：name → display_name → email → id", async () => {
    const { conn } = setup({
      app_user: [
        { id: "app_user:a", name: "有名字" },
        { id: "app_user:b", display_name: "有显示名" },
        { id: "app_user:c", email: "c@x.com" },
        { id: "app_user:d" },
      ],
    });

    const items = await resolveReferences(conn, ["app_user:a", "app_user:b", "app_user:c", "app_user:d"]);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("app_user:a")?.primaryLabel).toBe("有名字");
    expect(byId.get("app_user:b")?.primaryLabel).toBe("有显示名");
    expect(byId.get("app_user:c")?.primaryLabel).toBe("c@x.com");
    expect(byId.get("app_user:d")?.primaryLabel).toBe("app_user:d");
  });

  test("显式 displayKey 优先于回退链", async () => {
    const { conn, calls } = setup({
      ent_claim: [{ id: "ent_claim:c1", name: "回退名", title: "标题值" }],
    });

    const items = await resolveReferences(conn, ["ent_claim:c1"], { ent_claim: "title" });
    expect(items[0].primaryLabel).toBe("标题值");
    // 显式 displayKey 进入 SELECT 投影
    expect(calls[0].sql).toContain("title");
  });

  test("库里查不到的 id → missing 占位", async () => {
    const { conn } = setup({ app_user: [] });
    const items = await resolveReferences(conn, ["app_user:gone"]);
    expect(items[0].missing).toBe(true);
    expect(items[0].primaryLabel).toBe("已删除的记录");
  });

  test("非法 id 直接跳过，不发查询", async () => {
    const { conn, calls } = setup({});
    const items = await resolveReferences(conn, ["notARecordId"]);
    expect(items).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("searchReferenceCandidates — 直连候选搜索", () => {
  test("有 query → WHERE <displayKey> CONTAINS $q LIMIT N，参数化", async () => {
    const { conn, calls } = setup({
      app_user: [{ id: "app_user:u1", name: "张三" }, { id: "app_user:u2", name: "李四" }],
    });

    const items = await searchReferenceCandidates(conn, "app_user", { query: "张", displayKey: "name", limit: 10 });

    expect(calls[0].sql).toMatch(/FROM type::table\(\$tb\)/);
    expect(calls[0].sql).toMatch(/CONTAINS \$q/);
    expect(calls[0].sql).toMatch(/LIMIT 10/);
    expect((calls[0].bindings as { q: string }).q).toBe("张");
    expect(items.map((i) => i.id)).toContain("app_user:u1");
  });

  test("空 query → 不带 WHERE，返回前 N 条", async () => {
    const { conn, calls } = setup({
      app_user: [{ id: "app_user:u1", name: "张三" }],
    });

    await searchReferenceCandidates(conn, "app_user", { displayKey: "name" });

    expect(calls[0].sql).not.toMatch(/CONTAINS/);
    expect(calls[0].sql).toMatch(/LIMIT/);
  });
});

describe("listReferenceTargets — 直连枚举本 workspace 可引用目标", () => {
  test("系统对象 user 恒在首位，sheet 记录派生 ent_* 目标（label = 工作簿 / Sheet，displayKeys 来自 column_defs）", async () => {
    const calls: Array<{ sql: string }> = [];
    const conn = {
      status: "connected",
      query: (async (sql: string) => {
        calls.push({ sql });
        return [
          {
            id: "sheet:s1",
            label: "债权表",
            table_name: "ent_claim",
            workbook: "workbook:w1",
            workbook_name: "破产案A",
            column_defs: [
              { key: "name", label: "名称", field_type: "text" },
              { key: "amount", label: "金额", field_type: "decimal" },
            ],
          },
        ];
      }),
    } as unknown as SurrealConn;

    const targets = await listReferenceTargets(conn);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM sheet");

    expect(targets[0]).toEqual({
      table: "user",
      label: "系统：用户",
      displayKeys: [
        { key: "display_name", label: "显示名", fieldType: "text" },
        { key: "email", label: "邮箱", fieldType: "text" },
      ],
    });
    expect(targets[1]).toEqual({
      table: "ent_claim",
      label: "破产案A / 债权表",
      workbookId: "workbook:w1",
      workbookName: "破产案A",
      sheetId: "sheet:s1",
      sheetName: "债权表",
      displayKeys: [
        { key: "name", label: "名称", fieldType: "text" },
        { key: "amount", label: "金额", fieldType: "decimal" },
      ],
    });
  });
});
