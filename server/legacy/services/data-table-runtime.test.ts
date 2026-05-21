import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  assertRowIdBelongsToTable,
  buildEntityFieldDdl,
  buildEntityTableDdl,
  compileSelectOnly,
  createDataTableRuntime,
  generateEntityTableName,
  generateRelationTableName,
  gridColumnToStoredDef,
  normalizeGridColumnDef,
  omitNullishInsertValues,
  type StoredColumnDef,
} from "./data-table-runtime";
import type { GridColumnDef, ViewParams } from "../../shared/rpc.types";

describe("数据表运行时字段定义", () => {
  test("动态实体表 DDL 带同步元字段和 CHANGEFEED", () => {
    const ddl = buildEntityTableDdl("ent_contract");
    expect(ddl).toContain("DEFINE TABLE IF NOT EXISTS ent_contract SCHEMALESS CHANGEFEED 7d PERMISSIONS FULL");
    expect(ddl).toContain("DEFINE FIELD OVERWRITE _origin_session_id ON TABLE ent_contract TYPE option<string>");
    expect(ddl).toContain("DEFAULT ALWAYS ($current_session_id ?? NONE)");
    expect(ddl).toContain("REMOVE EVENT IF EXISTS ent_contract_origin_session ON TABLE ent_contract");
  });

  test("动态字段 DDL 可选择 IF NOT EXISTS 或 OVERWRITE", () => {
    const column: GridColumnDef = {
      key: "title",
      label: "标题",
      fieldType: "text",
    };
    expect(buildEntityFieldDdl("ent_contract", column, "if-not-exists"))
      .toContain("DEFINE FIELD IF NOT EXISTS title ON TABLE ent_contract TYPE option<string>");
    expect(buildEntityFieldDdl("ent_contract", column, "overwrite"))
      .toContain("DEFINE FIELD OVERWRITE title ON TABLE ent_contract TYPE option<string>");
  });

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

describe("数据表运行时 schemaFields", () => {
  function makeRuntime(columnDefs: StoredColumnDef[]) {
    return createDataTableRuntime({
      id: new RecordId("sheet", "s1"),
      workbook: new RecordId("workbook", "wb1"),
      univer_id: "u1",
      table_name: "ent_demo",
      label: "Demo",
      position: 0,
      column_defs: columnDefs,
    });
  }

  test("用户字段映射为 fieldType + nullable 形态", () => {
    const runtime = makeRuntime([
      { key: "title", label: "标题", field_type: "text", required: true },
      { key: "owner", label: "负责人", field_type: "reference", reference_table: "app_user" },
    ]);
    const fields = runtime.schemaFields();
    expect(fields).toContainEqual({ key: "title", label: "标题", fieldType: "text", nullable: false });
    expect(fields).toContainEqual({ key: "owner", label: "负责人", fieldType: "reference", nullable: true, referenceTable: "app_user" });
  });

  test("schemaFields 追加 id/created_at/updated_at 审计字段", () => {
    const runtime = makeRuntime([
      { key: "title", label: "标题", field_type: "text" },
    ]);
    const fields = runtime.schemaFields();
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(["title", "id", "created_at", "updated_at"]);
  });

  test("label 为空时回退到 key", () => {
    const runtime = makeRuntime([
      { key: "k1", label: "", field_type: "text" },
    ]);
    const fields = runtime.schemaFields();
    expect(fields[0]).toMatchObject({ key: "k1", label: "k1" });
  });
});

describe("数据表运行时表名生成", () => {
  test("实体表名格式 ent_<ws8>_<wb8> 不带 suffix 时省略尾段", () => {
    const name = generateEntityTableName({
      workspaceId: "workspace:0123456789abcdef",
      workbookId: "workbook:fedcba9876543210ffff",
    });
    expect(name).toBe("ent_01234567_fedcba98");
  });

  test("实体表名 ent_<ws8>_<wb8>_<suffix> 接受任意 entityKey 风格 suffix", () => {
    const name = generateEntityTableName({
      workspaceId: "workspace:0123456789abcdef",
      workbookId: "workbook:fedcba9876543210ffff",
      suffix: "case",
    });
    expect(name).toBe("ent_01234567_fedcba98_case");
  });

  test("实体表名 suffix 也接受 hash 切片", () => {
    const name = generateEntityTableName({
      workspaceId: "workspace:0123456789abcdef",
      workbookId: "workbook:fedcba9876543210ffff",
      suffix: "abcd1234",
    });
    expect(name).toBe("ent_01234567_fedcba98_abcd1234");
  });

  test("关系表名 rel_<ws8>_<wb8>_<key> 始终带 suffix", () => {
    const name = generateRelationTableName({
      workspaceId: "workspace:0123456789abcdef",
      workbookId: "workbook:fedcba9876543210ffff",
      suffix: "assigned_to",
    });
    expect(name).toBe("rel_01234567_fedcba98_assigned_to");
  });

  test("生成的实体表名通过 assertEntityTableName", () => {
    const name = generateEntityTableName({
      workspaceId: "workspace:ws1",
      workbookId: "workbook:wb1",
      suffix: "main",
    });
    expect(name).toMatch(/^ent_[a-z0-9_]+$/);
  });

  test("生成的关系表名通过运行时关系表正则", () => {
    const name = generateRelationTableName({
      workspaceId: "workspace:ws1",
      workbookId: "workbook:wb1",
      suffix: "owns",
    });
    expect(name).toMatch(/^rel_[a-z0-9_]+$/);
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
