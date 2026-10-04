// 本地公司 fork 集成测试：对真实 workspace 模板跑利息重算的实际 SQL，
// 覆盖假连接测不到的引擎方言（如 ORDER BY 字段必须出现在投影）与
// SCHEMAFULL/FLEXIBLE 子定义约束。需先起本地实例：
//   surreal start --user root --pass root memory --bind 127.0.0.1:8000
//   RUN_LOCAL_SURREALDB_TESTS=1 bun test src/lib/claims-interest.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import {
  listClaimSubmissions,
  listInterestCalculations,
  recalculateSubmission,
} from "./claims-interest";
import { createBrowserConn, type SurrealConn } from "./surreal";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function setupWorkspace(): Promise<{ conn: SurrealConn }> {
  const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
  const database = `claims_interest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const authentication = {
    username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
    password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
  };

  const inspector = new Surreal();
  opened.push(inspector);
  await inspector.connect(url, { authentication, namespace, database });

  const scripts = await loadTemplateScripts({ oidcJwksUrl: "https://issuer.example.test/jwks.json" });
  for (const script of scripts) {
    await inspector.query(script.sql);
  }
  const conn = createBrowserConn(inspector);
  return { conn };
}

describe("利息重算 · 真实 fork 模板集成", () => {
  localSurrealTest("列申报 + 重算写快照 + 读快照全链路在真实 schema 下通过", async () => {
    const { conn } = await setupWorkspace();

    await conn.query(`
      CREATE creditor_roster:r1 SET subject_type = "enterprise", name = "集成测试债权人", identity_code = "INT-TEST-001";
      CREATE claim_submission:s1 SET
        roster_id = creditor_roster:r1,
        identity_code = "INT-TEST-001",
        principal = 100000,
        rate_segments = [
          { start: "2024-01-01", end: "2024-07-01", annual_rate: 0.06 },
          { start: "2024-07-01", end: "2025-01-01", annual_rate: 0.08 }
        ],
        interest_start = d"2024-01-01T00:00:00Z",
        interest_end = d"2025-01-01T00:00:00Z",
        interest_method = "simple",
        penalty = NONE,
        status = "draft";
    `);

    // ORDER BY created_at 必须在真实解析器下可执行（QA 曾在此抓到投影缺失）。
    const submissions = await listClaimSubmissions(conn);
    expect(submissions.map((s) => s.id)).toContain("claim_submission:s1");

    const res = await recalculateSubmission(conn, "claim_submission:s1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.segments.map((s) => s.interest)).toEqual([2991.78, 4032.88]);
    expect(res.result.total_interest).toBe(7024.66);

    const calcs = await listInterestCalculations(conn, "claim_submission:s1");
    expect(calcs).toHaveLength(1);
    expect(calcs[0]!.rule_version).toBe("interest-rules/v1");
    expect(calcs[0]!.days_total).toBe(366);
    expect(calcs[0]!.total_interest).toBe(7024.66);
  });

  localSurrealTest("无效申报重算返回错误且表内零写入", async () => {
    const { conn } = await setupWorkspace();
    await conn.query(`
      CREATE creditor_roster:r1 SET subject_type = "enterprise", name = "坏样本", identity_code = "INT-TEST-002";
      CREATE claim_submission:bad SET
        roster_id = creditor_roster:r1,
        identity_code = "INT-TEST-002",
        principal = 5000,
        rate_segments = [],
        interest_start = d"2024-01-01T00:00:00Z",
        interest_end = d"2024-06-01T00:00:00Z",
        status = "draft";
    `);
    const res = await recalculateSubmission(conn, "claim_submission:bad");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("empty-rate-segments");
    const n = await conn.query<{ n: number }>(
      `SELECT count() AS n FROM interest_calculation GROUP ALL;`,
    );
    expect(n[0]?.n ?? 0).toBe(0);
  });
});
