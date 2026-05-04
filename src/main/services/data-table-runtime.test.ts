import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  assertRowIdBelongsToTable,
  createDataTableRuntime,
  gridColumnToStoredDef,
  normalizeGridColumnDef,
  omitNullishInsertValues,
} from "./data-table-runtime";
import type { GridColumnDef } from "../../shared/rpc.types";

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
