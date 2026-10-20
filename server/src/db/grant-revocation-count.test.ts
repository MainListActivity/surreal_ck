import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GRANT_REVOCATION_TABLE, parseRevocationCount, revocationTableDefined } from "./grant-revocation-count";

describe("revocationTableDefined（INFO FOR DB 的 tables 映射）", () => {
  test("撤销表已定义 → true", () => {
    expect(revocationTableDefined([{ tables: { [GRANT_REVOCATION_TABLE]: "DEFINE TABLE content_grant_revocation" } }])).toBe(true);
  });

  test("tables 为空或仅含其它表 → false", () => {
    expect(revocationTableDefined([{ tables: {} }])).toBe(false);
    expect(revocationTableDefined([{ tables: { content_version: "DEFINE TABLE content_version" } }])).toBe(false);
  });

  test("表名精确匹配：前缀或后缀相近的表不算", () => {
    expect(revocationTableDefined([{ tables: { content_grant_revocation_archive: "x" } }])).toBe(false);
    expect(revocationTableDefined([{ tables: { old_content_grant_revocation: "x" } }])).toBe(false);
  });

  test("结果形状偏离一律抛错（失败关闭，不回落为 false/0）", () => {
    const shapes: unknown[] = [undefined, null, "", "tables", [], [null], [{}], [{ tables: null }], [{ tables: "content_grant_revocation" }], { tables: {} }];
    for (const shape of shapes) {
      expect(() => revocationTableDefined(shape)).toThrow();
    }
  });
});

describe("parseRevocationCount（SELECT count() … GROUP ALL）", () => {
  test("无行（表已定义但为空）→ 0", () => {
    expect(parseRevocationCount([[]])).toBe(0);
  });

  test("恰好一行且 count 为安全非负整数 → 原值", () => {
    expect(parseRevocationCount([[{ count: 0 }]])).toBe(0);
    expect(parseRevocationCount([[{ count: 3 }]])).toBe(3);
    expect(parseRevocationCount([[{ count: Number.MAX_SAFE_INTEGER }]])).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("count 不是安全非负整数 → 抛错", () => {
    const counts: unknown[] = ["3", "0", -1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, true, null, undefined, 10n];
    for (const count of counts) {
      expect(() => parseRevocationCount([[{ count }]])).toThrow();
    }
  });

  test("行缺少 count 字段或行本身异常 → 抛错", () => {
    expect(() => parseRevocationCount([[{}]])).toThrow();
    expect(() => parseRevocationCount([[null]])).toThrow();
    expect(() => parseRevocationCount([["3"]])).toThrow();
  });

  test("多行、语句结果缺失或整体形状异常 → 抛错", () => {
    expect(() => parseRevocationCount([[{ count: 1 }, { count: 2 }]])).toThrow();
    expect(() => parseRevocationCount([])).toThrow();
    expect(() => parseRevocationCount([{ count: 1 }])).toThrow();
    expect(() => parseRevocationCount(undefined)).toThrow();
    expect(() => parseRevocationCount(null)).toThrow();
  });
});

describe("grant-revocation-check-cli 接线（静态，不连接数据库）", () => {
  const source = readFileSync(join(import.meta.dir, "grant-revocation-check-cli.ts"), "utf8");

  test("表存在性只经 INFO FOR DB 判定，不再依据错误文本回落为 0", () => {
    expect(source).toContain('db.query("INFO FOR DB;")');
    expect(source).toContain("revocationTableDefined(");
    expect(source).not.toContain("does not exist");
    expect(source).not.toContain("includes(");
  });

  test("计数只经严格解析，任何失败以退出码 2 结束", () => {
    expect(source).toContain("parseRevocationCount(");
    expect(source).toContain("process.exit(2)");
    expect(source).not.toMatch(/typeof rows\[0\]/u);
  });
});
