import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import {
  seedPlatformOperators,
  type PlatformOperatorSeedClient,
} from "./platform-operator-seed";

class FakePlatformOperatorDb implements PlatformOperatorSeedClient {
  uses: Array<{ namespace: string; database: string }> = [];
  queries: Array<{ sql: string; params: Record<string, unknown> | undefined }> = [];

  async use(scope: { namespace: string; database: string }): Promise<void> {
    this.uses.push(scope);
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ sql, params });
    if (sql.includes("SELECT VALUE id FROM platform_operator")) {
      const subject = params?.subject;
      const suffix = typeof subject === "string" ? subject.replace(/[^A-Za-z0-9_-]/gu, "_") : "unknown";
      return [[new StringRecordId(`platform_operator:${suffix}`)]];
    }
    return [[]];
  }
}

describe("seedPlatformOperators", () => {
  test("未配置主体时完全 no-op", async () => {
    const db = new FakePlatformOperatorDb();

    await expect(seedPlatformOperators(db, { subjectsCsv: " , ", capabilitiesCsv: "content.read" })).resolves.toEqual({
      seededSubjects: [],
      capabilities: [],
    });
    expect(db.uses).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  test("主体已配置但能力为空时 fail closed", async () => {
    const db = new FakePlatformOperatorDb();

    await expect(seedPlatformOperators(db, { subjectsCsv: "user-1", capabilitiesCsv: "" }))
      .rejects.toThrow("requires PLATFORM_OPERATOR_CAPABILITIES");
    expect(db.uses).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  test("拒绝未登记的能力名", async () => {
    const db = new FakePlatformOperatorDb();

    await expect(seedPlatformOperators(db, {
      subjectsCsv: "user-1",
      capabilitiesCsv: "content.read,root.write",
    })).rejects.toThrow("root.write");
    expect(db.uses).toEqual([]);
  });

  test("按 subject 去重并只补缺失的 operator/capability", async () => {
    const db = new FakePlatformOperatorDb();

    const result = await seedPlatformOperators(db, {
      subjectsCsv: "user-1, user-1, user-2",
      capabilitiesCsv: "content.read, content.submit,content.read",
      displayName: "Content Ops",
      grantedBySubject: "deploy-admin",
      namespace: "main",
    });

    expect(result).toEqual({
      seededSubjects: ["user-1", "user-2"],
      capabilities: ["content.read", "content.submit"],
    });
    expect(db.uses).toEqual([{ namespace: "main", database: "_system" }]);

    const operatorWrites = db.queries.filter(({ sql }) => sql.includes("INSERT INTO platform_operator {"));
    expect(operatorWrites).toHaveLength(2);
    expect(operatorWrites[0]?.params).toEqual({ subject: "user-1", displayName: "Content Ops" });
    expect(operatorWrites[0]?.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(operatorWrites[0]?.sql).toContain("updated_at = time::now()");

    const capabilityWrites = db.queries.filter(({ sql }) => sql.includes("INSERT INTO platform_operator_capability {"));
    expect(capabilityWrites).toHaveLength(4);
    expect(capabilityWrites[0]?.params?.capability).toBe("content.read");
    expect(capabilityWrites[0]?.params?.grantedBySubject).toBe("deploy-admin");
    expect(capabilityWrites[0]?.params?.operator).toBeInstanceOf(StringRecordId);
    expect(capabilityWrites[0]?.sql).toContain("ON DUPLICATE KEY UPDATE updated_at = time::now()");
  });
});
