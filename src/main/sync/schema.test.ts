import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { LOCAL_ONLY_TABLES, SYNC_SCOPE } from "./scope";

const schema = readFileSync(join(process.cwd(), "schema/main.surql"), "utf8");

describe("同步 schema 回归", () => {
  test("固定同步表带 CHANGEFEED 和 _origin_session_id", () => {
    for (const { table } of SYNC_SCOPE) {
      expect(schema).toMatch(new RegExp(`DEFINE TABLE[^;]+${table}[^;]+CHANGEFEED 7d`, "s"));
      expect(schema).toContain(`DEFINE FIELD IF NOT EXISTS _origin_session_id ON TABLE ${table}`);
      expect(schema).toContain(`DEFINE EVENT OVERWRITE ${table}_origin_session`);
    }
  });

  test("仅本地表不带 CHANGEFEED 和 origin 字段", () => {
    for (const table of LOCAL_ONLY_TABLES) {
      const tableDefinition = schema.match(new RegExp(`DEFINE TABLE[^;]+${table}[^;]+;`, "s"))?.[0] ?? "";
      expect(tableDefinition).not.toContain("CHANGEFEED");
      expect(schema).not.toContain(`_origin_session_id ON TABLE ${table}`);
    }
  });
});
