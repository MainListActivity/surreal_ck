import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import { installExistingRecordQuotaGuards } from "./resource-quota";

type QueryCall = {
  sql: string;
  params?: Record<string, unknown>;
};

describe("existing data table quota guard installer", () => {
  test("回填记录计数并为每张已有动态实体表安装同一配额事件", async () => {
    const calls: QueryCall[] = [];
    const client = {
      async query(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params });
        if (sql.includes("FROM sheet")) {
          return [[
            { id: new StringRecordId("sheet:s1"), table_name: "ent_one" },
            { id: new StringRecordId("sheet:s2"), table_name: "ent_two" },
          ]];
        }
        if (sql.includes("SELECT count()")) {
          return [[{ count: params?.table === "ent_one" ? 2 : 4 }]];
        }
        return [[]];
      },
    };

    const result = await installExistingRecordQuotaGuards(client);

    expect(result).toEqual({ installed: 2 });
    const usageWrites = calls.filter((call) => call.sql.includes("INSERT INTO sheet_resource_usage"));
    expect(usageWrites).toHaveLength(2);
    expect(usageWrites[0]?.params?.sheet).toBeInstanceOf(StringRecordId);
    expect(usageWrites[0]?.params).toEqual({
      sheet: new StringRecordId("sheet:s1"),
      recordCount: 2,
    });
    const eventDefinitions = calls.filter((call) =>
      call.sql.includes("DEFINE EVENT OVERWRITE resource_quota_guard"));
    expect(eventDefinitions).toHaveLength(2);
    expect(eventDefinitions[0]?.sql).toContain("ON TABLE ent_one");
    expect(eventDefinitions[0]?.sql).toContain("sheet = sheet:s1");
    expect(eventDefinitions[1]?.sql).toContain("ON TABLE ent_two");
  });

  test("遇到不安全物理表名时停止，不执行后续动态 DDL", async () => {
    const calls: QueryCall[] = [];
    const client = {
      async query(sql: string) {
        calls.push({ sql });
        if (sql.includes("FROM sheet")) {
          return [[{ id: new StringRecordId("sheet:s1"), table_name: "ent_ok; REMOVE DATABASE main" }]];
        }
        return [[]];
      },
    };

    await expect(installExistingRecordQuotaGuards(client)).rejects.toThrow("invalid entity table name");
    expect(calls.some((call) => call.sql.includes("DEFINE EVENT"))).toBe(false);
  });
});
