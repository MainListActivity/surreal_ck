import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { AiAllowanceError, AiAllowanceService, type Queryable } from "./service";

/**
 * LCA05 共享 AI 额度账本合约测试：对真实 SurrealDB 跑 workspace template（含 035），
 * 覆盖并发扣款、幂等重试、失败释放、失联回收、桶到期、消费顺序、成员只读与双库隔离。
 * 费率与额度均使用测试值（种子修订 revision_label=test-rate-v1，自建测试桶）。
 */
const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
const rootUser = process.env.LOCAL_SURREAL_ROOT_USER ?? "root";
const rootPass = process.env.LOCAL_SURREAL_ROOT_PASS ?? "root";

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function rootNamespace(): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(url, { authentication: { username: rootUser, password: rootPass }, namespace });
  return db;
}

async function provision(database: string): Promise<{ session: Queryable }> {
  const ns = await rootNamespace();
  await ns.query(`DEFINE DATABASE ${database}`).collect();
  const db = new Surreal();
  opened.push(db);
  await db.connect(url, { authentication: { username: rootUser, password: rootPass }, namespace, database });
  for (const script of await loadTemplateScripts({ oidcJwksUrl: "https://idp.example.test/jwks.json" })) {
    await db.query(script.sql).collect();
  }
  await db.query(`
    CREATE user:owner CONTENT { subject: "owner", email: "o@x", kind: "human", is_admin: true };
    CREATE user:member CONTENT { subject: "member", email: "m@x", kind: "human", is_admin: false };
    DEFINE ACCESS member_test ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "human")
      DURATION FOR SESSION 1h;
  `).collect();
  return { session: db as unknown as Queryable };
}

/** 权益快照 stub：entitled 集合返回 ai_actions 与当前商业来源，其余 db 返回 null（遗留未计量）。 */
function fakeSystem(entitled: Readonly<Record<string, readonly string[]>>): Queryable {
  return {
    query: async (sql: string, bindings?: Record<string, unknown>) => {
      const db = String(bindings?.db ?? bindings?.w ?? "");
      if (sql.includes("current_product_entitlement")) {
        return [[entitled[db]
          ? { ai_actions: [...entitled[db]], base_kind: "subscription", base_id: "sub_lca05" }
          : null]];
      }
      if (sql.includes("db_name") || sql.includes("slug")) {
        return [[{ db_name: db }]];
      }
      return [[]];
    },
  };
}

function serviceFor(database: string, session: Queryable, entitled: Record<string, readonly string[]> = {}): AiAllowanceService {
  return new AiAllowanceService({
    workspaceSession: async () => session,
    systemSession: async () => fakeSystem(entitled),
    reservationWindowMs: 60_000,
  });
}

async function grantBucket(
  svc: AiAllowanceService,
  db: string,
  input: { kind: "plan_cycle" | "purchased" | "compensation"; amount: number; periodKey?: string; expiresAt?: Date; label?: string },
): Promise<void> {
  await svc.grant({
    db,
    kind: input.kind,
    amount: input.amount,
    label: input.label ?? `${input.kind} bucket`,
    periodKey: input.periodKey ?? (input.kind === "plan_cycle" ? "subscription:sub_lca05:cycle" : "test-period"),
    effectiveFrom: new Date(Date.now() - 60_000),
    expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
    operatorSubject: "ops-test",
  });
}

function rows<T>(result: unknown): T[] {
  const statement = Array.isArray(result) ? result[0] : result;
  return Array.isArray(statement) ? (statement as T[]) : [];
}

describe("LCA05 共享 AI 额度账本（真实 SurrealDB）", () => {
  localSurrealTest("预留→结算闭环：幂等重试不重复扣款，余额视图可读", async () => {
    const database = `lca05_flow_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    await grantBucket(svc, database, { kind: "plan_cycle", amount: 100 });

    const { StringRecordId } = await import("surrealdb");
    const actor = new StringRecordId("user:member");
    const begun = await svc.reserve({
      db: database, actor, channel: "interactive", actionKey: "research",
      idempotencyKey: "run-1", runId: "run-1",
    });
    expect(begun.metered).toBe(true);

    let balance = await svc.balance(database);
    expect(balance.available).toBe(95);
    expect(balance.reserved).toBe(5);

    // 幂等重试：同一幂等键返回既有预留，不再扣减
    const retry = await svc.reserve({
      db: database, actor, channel: "interactive", actionKey: "research",
      idempotencyKey: "run-1", runId: "run-1b",
    });
    expect(retry.metered && retry.reused).toBe(true);
    balance = await svc.balance(database);
    expect(balance.reserved).toBe(5);

    // 交付成功 → 结算（不超过披露上限）
    await svc.finishByRun({ db: database, runId: "run-1", outcome: "success" });
    balance = await svc.balance(database);
    expect(balance.available).toBe(95);
    expect(balance.reserved).toBe(0);

    const entries = rows<{ kind: string; amount: number }>(
      await session.query(`SELECT kind, amount, created_at FROM ai_ledger_entry ORDER BY created_at`).collect(),
    );
    expect(entries.map((e) => e.kind)).toEqual(["grant", "reserve", "settle"]);
  });

  localSurrealTest("模型失败释放预留；取消同理；失联预留经 deadline 清扫", async () => {
    const database = `lca05_fail_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    await grantBucket(svc, database, { kind: "plan_cycle", amount: 20 });

    const { StringRecordId } = await import("surrealdb");
    const actor = new StringRecordId("user:member");
    await svc.reserve({ db: database, actor, channel: "interactive", actionKey: "research", idempotencyKey: "r-fail", runId: "r-fail" });
    await svc.finishByRun({ db: database, runId: "r-fail", outcome: "failure" });
    expect((await svc.balance(database)).available).toBe(20);

    // 失联回收：deadline 很短的预留超时后被清扫，余额归还
    const shortWindow = new AiAllowanceService({
      workspaceSession: async () => session,
      systemSession: async () => fakeSystem({ [database]: ["research"] }),
      reservationWindowMs: 1,
    });
    await shortWindow.reserve({ db: database, actor, channel: "interactive", actionKey: "research", idempotencyKey: "r-lost", runId: "r-lost" });
    await new Promise((r) => setTimeout(r, 10));
    const swept = await svc.sweepExpired(session);
    expect(swept).toBe(1);
    expect((await svc.balance(database)).available).toBe(20);
    const lost = rows<{ status: string }>(
      await session.query(`SELECT status FROM ai_reservation WHERE idempotency_key = "r-lost"`).collect(),
    );
    expect(lost[0]?.status).toBe("expired");
  });

  localSurrealTest("并发预留余额不为负；最早到期与同到期套餐先于购买的消费顺序", async () => {
    const database = `lca05_conc_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    // 10 额度桶 vs 每次预留 5 → 并发 5 路只有 2 路成功
    await grantBucket(svc, database, { kind: "purchased", amount: 10 });

    const { StringRecordId } = await import("surrealdb");
    const actor = new StringRecordId("user:member");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        svc.reserve({
          db: database, actor, channel: "interactive", actionKey: "research",
          idempotencyKey: `conc-${i}`, runId: `conc-${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const denied = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof AiAllowanceError && r.reason.code === "ai-allowance-insufficient",
    ).length;
    expect(ok).toBe(2);
    expect(denied).toBe(3);
    const balance = await svc.balance(database);
    expect(balance.available).toBe(0);
    expect(balance.reserved).toBe(10);

    // 消费顺序：新周期里套餐周期桶（早到期）先于购买桶（晚到期）被消耗
    const database2 = `lca05_order_${Date.now().toString(36)}`;
    const { session: session2 } = await provision(database2);
    const svc2 = serviceFor(database2, session2, { [database2]: ["research"] });
    const later = new Date(Date.now() + 7_200_000);
    const sooner = new Date(Date.now() + 3_600_000);
    await svc2.grant({ db: database2, kind: "purchased", amount: 50, label: "purchased", periodKey: "p", effectiveFrom: new Date(Date.now() - 60_000), expiresAt: later, operatorSubject: "ops" });
    await svc2.grant({ db: database2, kind: "plan_cycle", amount: 50, label: "cycle", periodKey: "subscription:sub_lca05:2026-09", effectiveFrom: new Date(Date.now() - 60_000), expiresAt: sooner, operatorSubject: "ops" });
    await svc2.reserve({ db: database2, actor, channel: "interactive", actionKey: "research", idempotencyKey: "ord-1", runId: "ord-1" });
    const cycle = rows<{ available: number }>(
      await session2.query(`SELECT available FROM ai_allowance_bucket WHERE kind = "plan_cycle"`).collect(),
    );
    const purchased = rows<{ available: number }>(
      await session2.query(`SELECT available FROM ai_allowance_bucket WHERE kind = "purchased"`).collect(),
    );
    expect(cycle[0]?.available).toBe(45);
    expect(purchased[0]?.available).toBe(50);

    // 同到期：套餐/补偿先于购买
    const database3 = `lca05_tie_${Date.now().toString(36)}`;
    const { session: session3 } = await provision(database3);
    const svc3 = serviceFor(database3, session3, { [database3]: ["research"] });
    const sameExpiry = new Date(Date.now() + 3_600_000);
    await svc3.grant({ db: database3, kind: "purchased", amount: 50, label: "p", periodKey: "p", effectiveFrom: new Date(Date.now() - 60_000), expiresAt: sameExpiry, operatorSubject: "ops" });
    await svc3.grant({ db: database3, kind: "compensation", amount: 50, label: "c", periodKey: "c", effectiveFrom: new Date(Date.now() - 60_000), expiresAt: sameExpiry, operatorSubject: "ops" });
    await svc3.reserve({ db: database3, actor, channel: "interactive", actionKey: "research", idempotencyKey: "tie-1", runId: "tie-1" });
    const comp = rows<{ available: number }>(
      await session3.query(`SELECT available FROM ai_allowance_bucket WHERE kind = "compensation"`).collect(),
    );
    expect(comp[0]?.available).toBe(45);
  });

  localSurrealTest("桶到期：到期桶不参与预留；向已到期桶释放只记 writeoff 不恢复可用", async () => {
    const database = `lca05_exp_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    // 已到期桶
    await svc.grant({
      db: database, kind: "plan_cycle", amount: 50, label: "old cycle", periodKey: "subscription:sub_lca05:2026-08",
      effectiveFrom: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() - 3_600_000),
      operatorSubject: "ops",
    });
    await svc.grant({
      db: database, kind: "plan_cycle", amount: 50, label: "current cycle", periodKey: "subscription:sub_lca05:2026-09",
      effectiveFrom: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000),
      operatorSubject: "ops",
    });

    const { StringRecordId } = await import("surrealdb");
    const actor = new StringRecordId("user:member");
    await svc.reserve({ db: database, actor, channel: "interactive", actionKey: "research", idempotencyKey: "exp-1", runId: "exp-1" });
    const balance = await svc.balance(database);
    expect(balance.available).toBe(45); // 只扣当前周期桶
    expect(balance.expired).toBe(50);   // 旧桶整体计入已过期

    // 跨周期结算规则：桶到期后 release 只冲销不恢复可用
    await session.query(`UPDATE ai_allowance_bucket SET expires_at = time::now() - 1s WHERE period_key = "subscription:sub_lca05:2026-09"`).collect();
    await svc.release({ db: database, idempotencyKey: "exp-1", reason: "run_failed" });
    const buckets = rows<{ period_key: string; available: number; reserved: number }>(
      await session.query(`SELECT period_key, available, reserved FROM ai_allowance_bucket ORDER BY period_key`).collect(),
    );
    const current = buckets.find((b) => b.period_key === "subscription:sub_lca05:2026-09");
    expect(current?.reserved).toBe(0);
    expect(current?.available).toBe(45); // 过期桶不恢复可用
    const writeoff = rows<{ kind: string }>(
      await session.query(`SELECT kind FROM ai_ledger_entry WHERE kind = "writeoff"`).collect(),
    );
    expect(writeoff.length).toBe(1);
  });

  localSurrealTest("成员只读不能写账本；额度不替代授权；两个 workspace database 隔离", async () => {
    const database = `lca05_iso_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    await grantBucket(svc, database, { kind: "plan_cycle", amount: 100 });

    // 普通成员会话：可读余额，不能写账本
    const member = new Surreal();
    opened.push(member);
    await member.connect(url, { namespace, database });
    await member.signin({ namespace, database, access: "member_test", variables: { subject: "member" } });
    const visible = rows<{ id: unknown }>(await member.query(`SELECT id FROM ai_allowance_bucket`).collect());
    expect(visible.length).toBe(1);
    const denied = await member.query(
      `CREATE ai_allowance_bucket CONTENT { kind: "purchased", label: "forge", period_key: "x", total: 9999, available: 9999, reserved: 0, settled: 0, effective_from: time::now(), expires_at: time::now() + 1h }`,
    ).collect();
    expect(rows(denied)).toHaveLength(0);
    const deniedRes = await member.query(
      `CREATE ai_reservation CONTENT { actor: user:member, channel: "interactive", action_key: "research", rate: ai_rate_card:research_test_v1, idempotency_key: "forge", run_id: "forge", bucket: $b, max_amount: 1, deadline: time::now() + 1h }`,
      { b: visible[0]?.id },
    ).collect();
    expect(rows(deniedRes)).toHaveLength(0);

    // 隔离：第二个 workspace db 看不到账本
    const other = `lca05_iso2_${Date.now().toString(36)}`;
    const { session: sessionB } = await provision(other);
    const inB = rows<{ id: unknown }>(await sessionB.query(`SELECT id FROM ai_allowance_bucket`).collect());
    expect(inB).toHaveLength(0);

    // 无权益快照的 workspace → 遗留路径不计量放行
    const legacy = `lca05_legacy_${Date.now().toString(36)}`;
    const { session: legacySession } = await provision(legacy);
    const legacySvc = serviceFor(legacy, legacySession, {});
    const { StringRecordId } = await import("surrealdb");
    const out = await legacySvc.reserve({
      db: legacy, actor: new StringRecordId("user:member"), channel: "interactive",
      actionKey: "research", idempotencyKey: "l1", runId: "l1",
    });
    expect(out.metered).toBe(false);

    // 有快照但动作不在 ai_actions → 拒绝
    const svcDenied = serviceFor(database, session, { [database]: ["generate"] });
    await expect(
      svcDenied.reserve({
        db: database, actor: new StringRecordId("user:member"), channel: "interactive",
        actionKey: "research", idempotencyKey: "d1", runId: "d1",
      }),
    ).rejects.toMatchObject({ code: "ai-action-not-entitled" });
  });

  localSurrealTest("50/80/100 阈值提示按周期去重；结算不得超过披露上限", async () => {
    const database = `lca05_alert_${Date.now().toString(36)}`;
    const { session } = await provision(database);
    const svc = serviceFor(database, session, { [database]: ["research"] });
    await grantBucket(svc, database, { kind: "plan_cycle", amount: 10, periodKey: "subscription:sub_lca05:2026-09" });

    const { StringRecordId } = await import("surrealdb");
    const actor = new StringRecordId("user:member");
    // 两次 run 各扣 5 → 累计 10/10 → 依次跨过 50/80/100
    for (const key of ["a1", "a2"]) {
      await svc.reserve({ db: database, actor, channel: "interactive", actionKey: "research", idempotencyKey: key, runId: key });
      await svc.finishByRun({ db: database, runId: key, outcome: "success" });
    }
    const notices = rows<{ threshold: number }>(
      await session.query(`SELECT threshold FROM ai_allowance_notice ORDER BY threshold`).collect(),
    );
    expect(notices.map((n) => n.threshold)).toEqual([50, 80, 100]);

    // 重复结算同一路径幂等（第二次 finishByRun 不再产生提示/扣款）
    await svc.finishByRun({ db: database, runId: "a2", outcome: "success" });
    const noticesAfter = rows<{ id: unknown }>(
      await session.query(`SELECT id FROM ai_allowance_notice`).collect(),
    );
    expect(noticesAfter.length).toBe(3);

    // 超额结算被拒：补一个桶让预留先成立，再尝试按超过披露上限结算
    await grantBucket(svc, database, { kind: "compensation", amount: 10, periodKey: "2026-09" });
    await svc.reserve({ db: database, actor, channel: "interactive", actionKey: "research", idempotencyKey: "over", runId: "over" });
    await expect(
      svc.settle({ db: database, idempotencyKey: "over", amount: 99 }),
    ).rejects.toThrow(/disclosed maximum|exceeds/);
  });
});
