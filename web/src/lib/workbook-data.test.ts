import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { GridColumnDef, ViewParams } from "@surreal-ck/shared/rpc.types";
import {
  buildSelect,
  describeWriteError,
  prepareRecordFields,
} from "./workbook-data";

const columns: GridColumnDef[] = [
  { key: "name", label: "名称", fieldType: "text" },
  { key: "amount", label: "金额", fieldType: "decimal" },
  { key: "status", label: "状态", fieldType: "single_select", options: ["新", "旧"] },
  { key: "owner", label: "负责人", fieldType: "reference", referenceTable: "app_user" },
];

describe("buildSelect", () => {
  test("无过滤时只生成参数化表名与分页", () => {
    const built = buildSelect("ent_claim", {}, columns, { limit: 100, start: 0 });
    expect(built.sql).toBe("SELECT * FROM type::table($tb) LIMIT 100 START 0");
    expect(built.bindings).toEqual({ tb: "ent_claim" });
  });

  test("过滤值参数化，多条件支持 OR", () => {
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

  test("排序仅接受 schema 中存在的字段", () => {
    const built = buildSelect(
      "ent_claim",
      { sorts: [{ key: "status", direction: "asc" }, { key: "evil; DROP TABLE x", direction: "desc" }] },
      columns,
      { limit: 50, start: 0 },
    );
    expect(built.sql).toBe("SELECT * FROM type::table($tb) ORDER BY status ASC LIMIT 50 START 0");
  });

  test("reference 过滤绑定 RecordId，普通文本保持 string", () => {
    const built = buildSelect(
      "ent_claim",
      { filters: [
        { key: "owner", op: "eq", value: "app_user:u1" },
        { key: "name", op: "eq", value: "app_user:not-id" },
      ] },
      columns,
      { limit: 50, start: 0 },
    );
    expect(built.bindings.f0).toBeInstanceOf(StringRecordId);
    expect(String(built.bindings.f0)).toBe("app_user:u1");
    expect(built.bindings.f1).toBe("app_user:not-id");
  });
});

describe("DataTableRuntime 共用的纯边界辅助", () => {
  test("prepareRecordFields 包装 reference 并省略 nullish 字段", () => {
    const result = prepareRecordFields(
      { name: "案件 A", owner: "app_user:u1", amount: null },
      columns,
    );
    expect(result.name).toBe("案件 A");
    expect(result.owner).toBeInstanceOf(StringRecordId);
    expect(String(result.owner)).toBe("app_user:u1");
    expect("amount" in result).toBe(false);
  });

  test("权限错误转换为统一中文语义", () => {
    expect(describeWriteError(new Error("IAM error: Not enough permissions"))).toContain("权限");
  });
});
