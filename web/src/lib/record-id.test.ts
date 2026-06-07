import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import {
  asBindable,
  isLikelyRecordId,
  recordValueToString,
  toRecordFieldValue,
  toRecordId,
} from "./record-id";

describe("isLikelyRecordId", () => {
  test("table:id 形态为真，其余为假", () => {
    expect(isLikelyRecordId("app_user:abc")).toBe(true);
    expect(isLikelyRecordId("ent_claim:1")).toBe(true);
    expect(isLikelyRecordId("noColon")).toBe(false);
    expect(isLikelyRecordId(":leading")).toBe(false);
    expect(isLikelyRecordId("trailing:")).toBe(false);
    expect(isLikelyRecordId(123)).toBe(false);
    expect(isLikelyRecordId(null)).toBe(false);
  });
});

describe("toRecordId", () => {
  test("包成 StringRecordId，序列化回原 id", () => {
    const r = toRecordId("workbook:wb1");
    expect(r).toBeInstanceOf(StringRecordId);
    expect(String(r)).toBe("workbook:wb1");
  });
});

describe("asBindable — 只对 record id 形态包裹", () => {
  test("record id → StringRecordId；普通标量原样", () => {
    expect(asBindable("app_user:u1")).toBeInstanceOf(StringRecordId);
    expect(asBindable("张三")).toBe("张三");
    expect(asBindable(100)).toBe(100);
    expect(asBindable(null)).toBe(null);
  });
});

describe("toRecordFieldValue — 写 record 字段前规整", () => {
  test("单值 record id → StringRecordId", () => {
    expect(toRecordFieldValue("app_user:u1")).toBeInstanceOf(StringRecordId);
  });
  test("数组逐项规整", () => {
    const out = toRecordFieldValue(["ent_p:1", "ent_p:2"]) as unknown[];
    for (const v of out) expect(v).toBeInstanceOf(StringRecordId);
    expect(out.map(String)).toEqual(["ent_p:1", "ent_p:2"]);
  });
  test("null / 非 record 字符串原样", () => {
    expect(toRecordFieldValue(null)).toBe(null);
    expect(toRecordFieldValue("plain")).toBe("plain");
  });
});

describe("recordValueToString — 读边界把 RecordId 实例规整回 string", () => {
  test("RecordId 实例 → table:id 字符串", () => {
    expect(recordValueToString(new RecordId("app_user", "u1"))).toBe("app_user:u1");
  });
  test("StringRecordId 实例 → 字符串", () => {
    expect(recordValueToString(new StringRecordId("ent_claim:c1"))).toBe("ent_claim:c1");
  });
  test("RecordId 数组逐项规整", () => {
    const out = recordValueToString([new RecordId("ent_p", "pa"), new RecordId("ent_p", "pb")]);
    expect(out).toEqual(["ent_p:pa", "ent_p:pb"]);
  });
  test("非 record 值原样返回", () => {
    expect(recordValueToString("张三")).toBe("张三");
    expect(recordValueToString(100)).toBe(100);
    expect(recordValueToString(null)).toBe(null);
  });
  test("规整出的字符串与 SDK 的 escaped 形态一致，可再被 toRecordId 无损包回", () => {
    // 需转义的 string id（如 "1"）：内存里存的是 escaped 形态 t:⟨1⟩，
    // 再 toRecordId 包回仍是 t:⟨1⟩——内存与 SDK 边界来回一致，不丢类型/不串记录。
    const escaped = recordValueToString(new RecordId("t", "1")) as string;
    expect(escaped).toBe("t:⟨1⟩");
    expect(String(toRecordId(escaped))).toBe("t:⟨1⟩");
  });
});
