import { describe, expect, test } from "bun:test";
import { QueryError, StringRecordId, SurrealError } from "surrealdb";
import { AiAllowanceError, AiAllowanceService, isRetryableTxnError, type Queryable } from "./service";

/**
 * LCA05 reserve 单元回归（不依赖真实库）：
 * - 事务冲突（新结构化 + 旧引擎纯文本）有界重试；
 * - 非冲突 SurrealError 归一为 ai-allowance-unavailable（不再向路由泄漏不透明错误）；
 * - 预留 deadline 由数据库时钟 time::now()+duration::from_millis($window) 生成。
 * 账本语义本身仍由 service.integration.test.ts 对真实 SurrealDB 覆盖。
 */

const LEGACY_CONFLICT_MESSAGE = "The query was not executed due to a failed transaction";

function legacyConflict(): QueryError {
  return new QueryError({ code: -32000, message: LEGACY_CONFLICT_MESSAGE });
}

type RecordedQuery = { sql: string; bindings?: Record<string, unknown> };

/** 记录全部 SQL 的账本假会话；可注入冲突次数与任意失败。 */
class FakeLedger implements Queryable {
  queries: RecordedQuery[] = [];
  /** BEGIN 事务命中时按此次数先抛冲突再成功。 */
  conflictsLeft = 0;
  /** BEGIN 已成功执行过 → 幂等键 SELECT 返回已落账预留。 */
  txnDone = false;
  buckets: unknown[] = [{ id: "ai_allowance_bucket:b1" }];
  /** 命中 SQL 片段即抛错的注入表（先于内置分支）。 */
  failures: Array<{ match: string; error: unknown }> = [];

  private readonly reservation = {
    id: "ai_reservation:r1",
    actor: "user:m",
    channel: "interactive",
    action_key: "research",
    rate: "ai_rate_card:r",
    idempotency_key: "k",
    run_id: "run",
    bucket: "ai_allowance_bucket:b1",
    max_amount: 5,
    status: "reserved",
    deadline: new Date(),
  };

  async query(sql: string, bindings?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ sql, bindings });
    for (const f of this.failures) {
      if (sql.includes(f.match)) throw f.error;
    }
    if (sql.includes("FROM ai_rate_card")) {
      return [[{ id: "ai_rate_card:r", amount: 5, revision: 1 }]];
    }
    if (sql.includes("deadline <= time::now()")) return [[]];
    if (sql.includes("FROM ai_allowance_bucket")) {
      return [this.buckets];
    }
    if (sql.includes("BEGIN")) {
      if (this.conflictsLeft > 0) {
        this.conflictsLeft -= 1;
        throw legacyConflict();
      }
      this.txnDone = true;
      return [];
    }
    if (sql.includes("FROM ai_reservation") && sql.includes("idempotency_key")) {
      return [this.txnDone ? [this.reservation] : []];
    }
    return [[]];
  }

  txnAttempts(): number {
    return this.queries.filter((q) => q.sql.includes("BEGIN")).length;
  }
}

const entitledSystem: Queryable = {
  query: async (sql: string) => {
    if (sql.includes("current_product_entitlement")) return [[{ ai_actions: ["research"] }]];
    return [[]];
  },
};

function serviceFor(ledger: FakeLedger, windowMs = 60_000): AiAllowanceService {
  return new AiAllowanceService({
    workspaceSession: async () => ledger,
    systemSession: async () => entitledSystem,
    reservationWindowMs: windowMs,
  });
}

const reserveInput = (key = "k") => ({
  db: "ws_x",
  actor: new StringRecordId("user:m"),
  channel: "interactive" as const,
  actionKey: "research",
  idempotencyKey: key,
  runId: "run",
});

describe("isRetryableTxnError", () => {
  test("3.1+ 结构化 TransactionConflict 命中", () => {
    const error = new QueryError({
      code: -32009,
      message: "txn conflict",
      details: { kind: "TransactionConflict" },
    });
    expect(isRetryableTxnError(error)).toBe(true);
  });

  test("旧引擎纯文本 failed transaction 命中（生产实测形状）", () => {
    expect(isRetryableTxnError(legacyConflict())).toBe(true);
  });

  test("其它错误不命中", () => {
    expect(isRetryableTxnError(new SurrealError("connection reset"))).toBe(false);
    expect(isRetryableTxnError(new QueryError({ code: -32000, message: "There was a problem with the database: Parse error" }))).toBe(false);
    expect(isRetryableTxnError(new TypeError("x.collect is not a function"))).toBe(false);
    expect(isRetryableTxnError(new AiAllowanceError("ai-allowance-insufficient", "x"))).toBe(false);
    expect(isRetryableTxnError(undefined)).toBe(false);
  });
});

describe("reserve 事务冲突", () => {
  test("冲突后有界重试：2 次冲突后成功预留", async () => {
    const ledger = new FakeLedger();
    ledger.conflictsLeft = 2;
    const svc = serviceFor(ledger);
    const out = await svc.reserve(reserveInput());
    expect(out.metered).toBe(true);
    if (out.metered) expect(out.reused).toBe(false);
    expect(ledger.txnAttempts()).toBe(3);
  });

  test("冲突超过上限 → ai-allowance-unavailable（retryable），不再泄漏原始 QueryError", async () => {
    const ledger = new FakeLedger();
    ledger.conflictsLeft = 99;
    const svc = serviceFor(ledger);
    await expect(svc.reserve(reserveInput())).rejects.toMatchObject({
      code: "ai-allowance-unavailable",
      details: { retryable: true },
    });
    expect(ledger.txnAttempts()).toBe(4);
  });
});

describe("reserve 错误归一与 deadline", () => {
  test("非冲突 SurrealError → ai-allowance-unavailable", async () => {
    const ledger = new FakeLedger();
    ledger.failures.push({ match: "FROM ai_rate_card", error: new SurrealError("internal database error") });
    const svc = serviceFor(ledger);
    await expect(svc.reserve(reserveInput())).rejects.toMatchObject({ code: "ai-allowance-unavailable" });
  });

  test("非冲突 QueryError（parse/权限类）→ ai-allowance-unavailable", async () => {
    const ledger = new FakeLedger();
    ledger.failures.push({
      match: "BEGIN",
      error: new QueryError({ code: -32000, message: "There was a problem with the database: Parse error" }),
    });
    const svc = serviceFor(ledger);
    await expect(svc.reserve(reserveInput())).rejects.toMatchObject({ code: "ai-allowance-unavailable" });
  });

  test("AiAllowanceError 原样透传不被归一覆盖", async () => {
    const ledger = new FakeLedger();
    ledger.buckets = [];
    const svc = serviceFor(ledger);
    await expect(svc.reserve(reserveInput())).rejects.toMatchObject({ code: "ai-allowance-insufficient" });
  });

  test("deadline 走数据库时钟：SQL 用 time::now()+duration::from_millis($window)，不带应用时钟 binding", async () => {
    const ledger = new FakeLedger();
    const svc = serviceFor(ledger, 123_456);
    await svc.reserve(reserveInput());
    const txn = ledger.queries.find((q) => q.sql.includes("BEGIN"));
    expect(txn).toBeDefined();
    expect(txn!.sql).toContain("deadline: time::now() + duration::from_millis($window)");
    expect(txn!.bindings).toMatchObject({ window: 123_456 });
    expect(txn!.bindings).not.toHaveProperty("deadline");
  });
});
