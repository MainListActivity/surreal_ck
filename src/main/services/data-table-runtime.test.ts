import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  assertRowIdBelongsToTable,
  compileSelectOnly,
  createDataTableRuntime,
  gridColumnToStoredDef,
  normalizeGridColumnDef,
  omitNullishInsertValues,
  type StoredColumnDef,
} from "./data-table-runtime";
import type { GridColumnDef, ViewParams } from "../../shared/rpc.types";

describe("数据表运行时字段定义", () => {
  test("字段定义会标准化为存储形态", () => {
    const column: GridColumnDef = {
      key: " status ",
      label: " 状态 ",
      fieldType: "single_select",
      required: true,
      options: ["Open", "Open", "Closed", ""],
      constraints: { maxLength: 20 },
    };

    const normalized = normalizeGridColumnDef(column);

    expect(normalized).toEqual({
      key: "status",
      label: "状态",
      fieldType: "single_select",
      required: true,
      options: ["Open", "Closed"],
      constraints: { maxLength: 20 },
      dateFormat: undefined,
      referenceTable: undefined,
      referenceSheetId: undefined,
      referenceMultiple: undefined,
      referenceDisplayKey: undefined,
    });
    expect(gridColumnToStoredDef(normalized)).toMatchObject({
      key: "status",
      label: "状态",
      field_type: "single_select",
      options: ["Open", "Closed"],
    });
  });

  test("保留系统字段名给运行时内部使用", () => {
    expect(() => normalizeGridColumnDef({
      key: "created_at",
      label: "创建时间",
      fieldType: "date",
    })).toThrow("无效的字段标识");
  });
});

describe("数据表运行时记录入口", () => {
  test("创建记录时跳过 null/undefined，但保留 false 和 0", () => {
    expect(omitNullishInsertValues({
      title: "合同 A",
      note: null,
      owner: undefined,
      enabled: false,
      count: 0,
    })).toEqual({
      title: "合同 A",
      enabled: false,
      count: 0,
    });
  });

  test("记录 id 必须属于当前动态实体表", () => {
    expect(() => assertRowIdBelongsToTable("ent_ws_book_a:row1", "ent_ws_book_b"))
      .toThrow("记录不属于当前 Sheet");
    expect(() => assertRowIdBelongsToTable("ent_ws_book_a:row1", "ent_ws_book_a"))
      .not.toThrow();
  });

  test("运行时拒绝非法动态实体表名", () => {
    expect(() => createDataTableRuntime({
      id: new RecordId("sheet", "s1"),
      workbook: new RecordId("workbook", "w1"),
      univer_id: "u1",
      table_name: "workbook",
      label: "Sheet 1",
      position: 0,
      column_defs: [],
    })).toThrow("无效的实体表名");
  });
});

describe("数据表读路径 compileSelectOnly", () => {
  const columnsByKey = new Map<string, StoredColumnDef>([
    ["status", { key: "status", label: "状态", field_type: "single_select" }],
    ["count", { key: "count", label: "数量", field_type: "number" }],
    ["title", { key: "title", label: "标题", field_type: "text" }],
  ]);

  test("无 viewParams 时只产生最基础的 SELECT", () => {
    const bq = compileSelectOnly("ent_demo", undefined, columnsByKey);
    expect(bq.query).toBe("SELECT * FROM type::table($t) LIMIT 5000");
    expect(bq.bindings).toEqual({ t: "ent_demo" });
  });

  test("永远以受控前缀开头 - 这是出路 3 的物理保证", () => {
    const params: ViewParams = {
      filters: [{ key: "status", op: "eq", value: "Open" }],
      sorts: [{ key: "count", direction: "desc" }],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query.startsWith("SELECT * FROM type::table($t)")).toBe(true);
    expect(bq.query).not.toMatch(/UPDATE|DELETE|CREATE|DEFINE|REMOVE/i);
  });

  test("WHERE 子句通过 SDK 表达式生成,值走绑定", () => {
    const params: ViewParams = {
      filters: [
        { key: "status", op: "eq", value: "Open" },
        { key: "count", op: "gte", value: 10 },
      ],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toContain(" WHERE ");
    expect(bq.query).toContain("status = $");
    expect(bq.query).toContain("count >= $");
    expect(bq.query).toContain(" AND ");
    expect(Object.values(bq.bindings)).toContain("Open");
    expect(Object.values(bq.bindings)).toContain(10);
  });

  test("filterMode=or 时用 OR 连接", () => {
    const params: ViewParams = {
      filterMode: "or",
      filters: [
        { key: "status", op: "eq", value: "Open" },
        { key: "status", op: "eq", value: "Closed" },
      ],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toContain(" OR ");
    expect(bq.query).not.toMatch(/\bAND\b/);
  });

  test("is_null / is_not_null 用 IS NULL / IS NOT NULL", () => {
    const params: ViewParams = {
      filters: [
        { key: "status", op: "is_null" },
        { key: "title", op: "is_not_null" },
      ],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toContain("status IS NULL");
    expect(bq.query).toContain("title IS NOT NULL");
  });

  test("not_contains 通过 NOT(CONTAINS) 表达", () => {
    const params: ViewParams = {
      filters: [{ key: "title", op: "not_contains", value: "草稿" }],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toMatch(/NOT\s*\(\s*title CONTAINS \$/);
  });

  test("未在列定义中声明的过滤键被忽略", () => {
    const params: ViewParams = {
      filters: [
        { key: "status", op: "eq", value: "Open" },
        { key: "ghost_field", op: "eq", value: "x" },
      ],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toContain("status = $");
    expect(bq.query).not.toContain("ghost_field");
  });

  test("ORDER BY 仅在列定义白名单内生效", () => {
    const params: ViewParams = {
      sorts: [
        { key: "count", direction: "desc" },
        { key: "ghost_field", direction: "asc" },
      ],
    };
    const bq = compileSelectOnly("ent_demo", params, columnsByKey);
    expect(bq.query).toContain(" ORDER BY count DESC");
    expect(bq.query).not.toContain("ghost_field");
  });
});
