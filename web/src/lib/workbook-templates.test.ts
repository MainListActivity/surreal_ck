import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import {
  createWorkbookTemplatesStore,
  recordToTemplate,
  templateColumnDefs,
} from "./workbook-templates";

function setup(rows: Array<Record<string, unknown>>) {
  const queries: string[] = [];
  const conn = {
    query: (async (sql: string) => {
      queries.push(sql);
      return rows;
    }) as SurrealConn["query"],
  } as SurrealConn;
  const store = createWorkbookTemplatesStore({ getConn: () => conn });
  return { store, queries };
}

const caseRow = {
  id: "workbook_template:case",
  key: "case",
  label: "案件管理",
  description: "诉讼 / 破产案件全流程台账",
  icon: "scale",
  accent: "#CC6B3A",
  default_name: "未命名案件库",
  column_defs: [{ key: "name", label: "案件名", field_type: "text", required: true }],
  builtin: true,
  sort_order: 10,
};

describe("recordToTemplate — snake_case → camelCase", () => {
  test("展示元数据与列定义都被裁出，builtin/sort_order 规范化", () => {
    expect(recordToTemplate(caseRow)).toEqual({
      id: "workbook_template:case",
      key: "case",
      label: "案件管理",
      description: "诉讼 / 破产案件全流程台账",
      icon: "scale",
      accent: "#CC6B3A",
      defaultName: "未命名案件库",
      columnDefs: [{ key: "name", label: "案件名", field_type: "text", required: true }],
      builtin: true,
      sortOrder: 10,
    });
  });

  test("缺省字段回退：无 icon/accent/default_name 不报错，builtin 默认 false", () => {
    const t = recordToTemplate({ id: "workbook_template:x", key: "x", label: "X" });
    expect(t.icon).toBeUndefined();
    expect(t.accent).toBeUndefined();
    expect(t.builtin).toBe(false);
    expect(t.sortOrder).toBe(0);
    expect(t.columnDefs).toEqual([]);
  });
});

describe("templateColumnDefs — stored → GridColumnDef", () => {
  test("把模板存储列定义转成建表用的 camelCase 列", () => {
    const t = recordToTemplate(caseRow);
    expect(templateColumnDefs(t)).toEqual([
      expect.objectContaining({ key: "name", label: "案件名", fieldType: "text", required: true }),
    ]);
  });
});

describe("createWorkbookTemplatesStore — 直连读模板", () => {
  test("SELECT FROM workbook_template ORDER BY sort_order，记录裁成模板", async () => {
    const { store, queries } = setup([caseRow]);
    await store.load();
    expect(queries[0]).toMatch(/FROM workbook_template/i);
    expect(queries[0]).toMatch(/ORDER BY sort_order/i);
    expect(store.templates).toHaveLength(1);
    expect(store.byKey("case")?.label).toBe("案件管理");
    expect(store.byKey("missing")).toBeUndefined();
  });

  test("查询抛错 → error 落到 state，列表保持空", async () => {
    const broken = createWorkbookTemplatesStore({
      getConn: () => ({ query: async () => { throw new Error("boom"); } }) as unknown as SurrealConn,
    });
    await broken.load();
    expect(broken.error).not.toBeNull();
    expect(broken.templates).toEqual([]);
  });
});
