import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { createRolloutGateChecker } from "./gate-check";
import { RolloutGateService } from "./service";
import { SurrealRolloutStore } from "./store";

/**
 * LCA14 灰度控制面集成测试：真实 SurrealDB fork（本地实例）跑通
 * 027 迁移 + SurrealRolloutStore + RolloutGateService + gate checker。
 * 默认跳过；RUN_LOCAL_SURREALDB_ROLLOUT_TESTS=1 且 LOCAL_SURREAL_URL
 * 指向本地 fork（默认 ws://127.0.0.1:8999/rpc）时执行。
 */
const localTest = (name: string, fn: () => Promise<void>) =>
  test.skipIf(process.env.RUN_LOCAL_SURREALDB_ROLLOUT_TESTS !== "1")(name, fn, 60_000);

const actor = { subject: "ops:it", capabilities: ["quota.read", "rollout.manage"] } as const;

async function connect() {
  const namespace = `rollout_it_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = new Surreal();
  await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc", {
    namespace,
    database: "_system",
    authentication: { username: "root", password: "root" },
  });
  return { db, namespace };
}

describe("LCA14 rollout store 集成（真实 fork）", () => {
  localTest("027 迁移可应用；store+service 完成登记/开关/审计闭环；事件不可变", async () => {
    const { db, namespace } = await connect();
    try {
      const schema = await ensureSystemSchema(db, { namespace });
      expect(schema.toVersion).toBeGreaterThanOrEqual(27);

      const store = new SurrealRolloutStore(async () => db as never, namespace);
      const service = new RolloutGateService(store);

      // 种一个验收 workspace 行。
      await db.query(
        `CREATE workspace CONTENT {
          db_name: $dbName, owner_subject: "ops:it", slug: $slug,
          name: "验收工作区", status: "active"
        };`,
        { dbName: "ws_accept_a", slug: "accept-a" },
      );

      // 具名批次：登记 → 激活。
      const batch = await service.registerBatch(actor, {
        batchKey: "it-batch-1",
        label: "集成验收批次",
        appRelease: "test-sha",
        idpRelease: "test-idp",
        schemaRevision: "system-027",
        legalSources: [{ sourceKey: "s1", label: "来源一", licenseNote: "许可依据" }],
        planMapping: [{ planKey: "pro", displayName: "Pro", aiRate: "1/run", trialAllowance: null, legacySubscriptionMap: "无" }],
        allowedWorkspaces: ["accept-a"],
        gaps: ["Pro Max 未开放"],
        reason: "集成测试",
        idempotencyKey: "it-batch-register-1",
      });
      expect(batch.status).toBe("draft");
      expect(batch.createdAt).toBeTruthy();
      await service.transitionBatch(actor, "it-batch-1", { status: "active", reason: "激活", idempotencyKey: "it-batch-activate-1" });
      // 幂等重放：同键同体返回既有批次。
      const replay = await service.registerBatch(actor, {
        batchKey: "it-batch-1",
        label: "集成验收批次",
        appRelease: "test-sha",
        idpRelease: "test-idp",
        schemaRevision: "system-027",
        legalSources: [{ sourceKey: "s1", label: "来源一", licenseNote: "许可依据" }],
        planMapping: [{ planKey: "pro", displayName: "Pro", aiRate: "1/run", trialAllowance: null, legacySubscriptionMap: "无" }],
        allowedWorkspaces: ["accept-a"],
        gaps: ["Pro Max 未开放"],
        reason: "集成测试",
        idempotencyKey: "it-batch-register-1",
      });
      expect(replay.batchKey).toBe("it-batch-1");

      // 开关：无行 → enabled（gate checker 实读）。
      const check = createRolloutGateChecker({ getSystemDb: async () => db as never });
      await expect(check("ws_accept_a", "legal_content_access")).resolves.toBe("enabled");

      // disable（不受名单限制）→ 状态落库 + 审计事件。
      const disabled = await service.setGate(actor, "accept-a", {
        gate: "legal_content_access",
        action: "disable",
        reason: "演练关闭",
        idempotencyKey: "it-gate-disable-1",
      });
      expect(disabled).toMatchObject({ state: "disabled", revision: 1 });
      await expect(check("ws_accept_a", "legal_content_access")).resolves.toBe("disabled");
      // 另一枚开关不受影响。
      await expect(check("ws_accept_a", "legal_research_ai")).resolves.toBe("enabled");

      // restore：目标在 active 批次名单内 → 放行。
      const restored = await service.setGate(actor, "accept-a", {
        gate: "legal_content_access",
        action: "restore",
        reason: "演练恢复",
        batchKey: "it-batch-1",
        idempotencyKey: "it-gate-restore-1",
      });
      expect(restored).toMatchObject({ state: "enabled", revision: 2, batchKey: "it-batch-1" });

      // 审计：操作事件完整落库且不可改。
      const opsResult = await db.query(
        `SELECT kind, before_state, after_state, before_revision, after_revision,
                actor_subject, authorized_capability, batch_key, correlation_id, occurred_at
          FROM rollout_operation ORDER BY occurred_at;`,
      );
      const events = (opsResult as unknown[][])[0] as Record<string, unknown>[];
      expect(events.map((e) => e.kind)).toEqual([
        "batch_register", "batch_activate", "gate_disable", "gate_restore",
      ]);
      // 注意：surrealdb-js 的 query() 不是原生 Promise，bun 的 expect().rejects 不订阅
      // 其 thenable 会挂起——用 try/catch 捕获拒绝。
      let tamperError: unknown = null;
      try {
        await db.query(`UPDATE rollout_operation SET reason = "tamper" WHERE batch_key = "it-batch-1";`);
      } catch (error) {
        tamperError = error;
      }
      expect(String(tamperError)).toMatch(/immutable/u);

      // workspaceStatus 视图聚合。
      const status = await service.workspaceStatus(actor, "accept-a");
      expect(status.gates.find((g) => g.gate === "legal_content_access")?.state).toBe("enabled");
      expect(status.activeBatches).toContain("it-batch-1");
    } finally {
      await db.close().catch(() => {});
    }
  });
});
