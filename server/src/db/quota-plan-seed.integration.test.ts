import { afterEach, describe, expect, test } from "bun:test";
import { jsonify, Surreal } from "surrealdb";
import { seedQuotaPlans, type QuotaPlanSeedClient } from "./quota-plan-seed";
import { MAX_V2_LIMITS, SEEDED_PLAN_LIMITS } from "./quota-plan-rules";

/**
 * CV02：seedQuotaPlans 在公司 fork 真机上的幂等验证。
 * quota_plan / quota_plan_revision 是 _system 控制面表；测试实例里用
 * SCHEMALESS 占位（真实字段约束由 shared/sql/system 迁移链保证，seed 只依赖
 * 记录读写）。两次执行后：max_v2 修订仅一行、v1 修订保留、
 * quota_plan:max.active_revision 指向 v2。
 */

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

const SURREAL_URL = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_NS = process.env.LOCAL_SURREAL_NS ?? "main";
const AUTH = {
  username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
  password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
};

describe("seedQuotaPlans — Max v2 修订（公司 fork 真机）", () => {
  localSurrealTest("两次 seed 幂等：max_v2 一行、v1 保留、active_revision 指向 v2", async () => {
    const database = `cv02_seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const db = new Surreal();
    opened.push(db);
    await db.connect(SURREAL_URL, { authentication: AUTH });
    await db.query(
      `DEFINE NAMESPACE IF NOT EXISTS ${SURREAL_NS}; USE NS ${SURREAL_NS}; DEFINE DATABASE IF NOT EXISTS ${database};`,
    ).collect();
    await db.use({ namespace: SURREAL_NS, database });
    await db.query(`
      DEFINE TABLE quota_plan SCHEMALESS;
      DEFINE TABLE quota_plan_revision SCHEMALESS;
    `).collect();

    const client: QuotaPlanSeedClient = {
      query: async (sql, params) => await db.query(sql, params),
    };
    const runSeed = () => seedQuotaPlans({
      namespace: SURREAL_NS,
      createdBySubject: "system:test",
      getDbSession: async () => client,
    });
    await runSeed();
    await runSeed();

    const revisions = jsonify(
      (await db.query<[unknown[]]>(
        "SELECT id, revision FROM quota_plan_revision WHERE id IN [quota_plan_revision:max_v1, quota_plan_revision:max_v2];",
      ))[0],
    ) as Array<{ id: string; revision: number }>;
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.id).sort()).toEqual([
      "quota_plan_revision:max_v1",
      "quota_plan_revision:max_v2",
    ]);

    const v2Rules = jsonify(
      (await db.query<[{ rules: unknown[] }]>(
        "SELECT rules FROM ONLY quota_plan_revision:max_v2;",
      ))[0]?.rules,
    ) as Array<{ resource: string; selector: { kind: string; value: string }; limit: { kind: string; value?: number } }>;
    const entLimit = (resource: string) => v2Rules.find(
      (rule) => rule.resource === resource && rule.selector.kind === "regex" && rule.selector.value === "^ent_",
    )?.limit;
    expect(entLimit("table")).toEqual({ kind: "finite", value: MAX_V2_LIMITS.tables });
    expect(entLimit("field")).toEqual({ kind: "finite", value: MAX_V2_LIMITS.fields });
    expect(entLimit("record")).toEqual({ kind: "finite", value: MAX_V2_LIMITS.records });

    const plan = jsonify(
      (await db.query<[{ active_revision: string }]>(
        "SELECT active_revision FROM ONLY quota_plan:max;",
      ))[0],
    );
    expect(plan?.active_revision).toBe("quota_plan_revision:max_v2");

    // 其他套餐仍指向各自 v1，未受影响。
    for (const key of ["plus", "pro"] as const) {
      const row = jsonify(
        (await db.query<[{ active_revision: string }]>(
          `SELECT active_revision FROM ONLY quota_plan:${key};`,
        ))[0],
      );
      expect(row?.active_revision).toBe(`quota_plan_revision:${key}_v1`);
      expect(SEEDED_PLAN_LIMITS[key]).toBeDefined();
    }
  }, 30_000);
});
