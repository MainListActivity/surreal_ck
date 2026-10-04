// 本地公司 fork 集成测试：对真实 workspace 模板跑对账的实际 SQL——
// loadReconciliation 七路读取（含 ORDER BY 投影约束）、finding UPSERT、
// supplement 追加与排序、ALLINSIDE 四类枚举断言。
//   surreal start --user root --pass root memory --bind 127.0.0.1:8000
//   RUN_LOCAL_SURREALDB_TESTS=1 bun test src/lib/claims-reconcile.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import {
  loadReconciliation,
  saveFinding,
  sendSupplementRequest,
} from "./claims-reconcile";
import { createBrowserConn, type SurrealConn } from "./surreal";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function setupWorkspace(): Promise<{ conn: SurrealConn }> {
  const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
  const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
  const database = `claims_recon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
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

describe("债权对账 · 真实 fork 模板集成", () => {
  localSurrealTest("055 表建好：装配四列、finding UPSERT 往返、supplement 追加排序", async () => {
    const { conn } = await setupWorkspace();

    await conn.query(`
      CREATE creditor_roster:r1 SET subject_type = "enterprise", name = "集成测试债权人", identity_code = "INT-RECON-001";
      CREATE enterprise_ledger:l1 SET identity_code = "INT-RECON-001", principal = 100000, book_interest = 7024.66;
      CREATE claim_submission:s1 SET
        roster_id = creditor_roster:r1,
        identity_code = "INT-RECON-001",
        principal = 110000,
        rate_segments = [
          { start: "2024-01-01", end: "2024-07-01", annual_rate: 0.06 },
          { start: "2024-07-01", end: "2025-01-01", annual_rate: 0.08 }
        ],
        interest_start = d"2024-01-01T00:00:00Z",
        interest_end = d"2025-01-01T00:00:00Z",
        interest_method = "simple",
        penalty = NONE,
        status = "submitted";
      CREATE interest_calculation:c1 SET
        submission_id = claim_submission:s1,
        rule_version = "interest-rules/v1",
        inputs = {},
        segments = [{ index: 0, start: "2024-01-01", end: "2025-01-01", days: 366, base: 100000, annual_rate: 0.07, interest: 7024.66 }],
        days_total = 366,
        total_interest = 7024.66,
        penalty_amount = 0,
        total_amount = 7024.66,
        calculated_at = d"2025-01-15T00:00:00Z";
    `);

    // 真实 schema 下七路读取：本金差一行（申报 110000 ≠ 账面 100000）。
    const first = await loadReconciliation(conn);
    expect(first.rows).toHaveLength(1);
    const row = first.rows[0]!;
    expect(row.categories).toEqual(["amount_mismatch", "missing_evidence"]);
    expect(row.calculation?.total_interest).toBe(7024.66);
    expect(row.book_principal).toBe(100000);

    // finding UPSERT：同 identity_code 覆盖 note/state，行数仍 1。
    await saveFinding(conn, {
      identity_code: "INT-RECON-001",
      categories: ["amount_mismatch"],
      manager_note: "初核：本金差一万元",
      state: "open",
      linked_submission_id: "claim_submission:s1",
      updated_by: "集成管理人",
    });
    await saveFinding(conn, {
      identity_code: "INT-RECON-001",
      categories: ["amount_mismatch", "missing_evidence"],
      manager_note: "已发补充要求",
      state: "waiting_creditor",
      linked_submission_id: "claim_submission:s1",
      updated_by: "集成管理人",
    });
    const second = await loadReconciliation(conn);
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.state).toBe("waiting_creditor");
    expect(second.findings[0]!.manager_note).toBe("已发补充要求");

    // supplement 追加 + ORDER BY created_at ASC 投影在真实解析器下可执行。
    await sendSupplementRequest(conn, {
      submission_id: "claim_submission:s1",
      body: "请补充银行流水",
      actor: "集成管理人",
    });
    const third = await loadReconciliation(conn);
    expect(third.supplements).toHaveLength(1);
    expect(third.supplements[0]!.direction).toBe("manager_request");
    expect(third.supplements[0]!.actor).toBe("集成管理人");
  });

  localSurrealTest("四类枚举断言：第五类 category 被 ALLINSIDE 拒绝", async () => {
    const { conn } = await setupWorkspace();
    await expect(
      saveFinding(conn, {
        identity_code: "BAD-1",
        categories: ["not_a_category" as never],
        manager_note: null,
        state: "open",
        updated_by: "x",
      }),
    ).rejects.toThrow();
  });
});
