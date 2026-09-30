import { describe, expect, test } from "bun:test";
import type { ClaimsRiskStore } from "./daily-claims-risk";
import {
  CLAIMS_RISK_REASON,
  ensureClaimsRiskEmployee,
  registerClaimsRiskHandler,
  runClaimsRiskReminderDispatch,
  type ClaimsRiskTriggerQueue,
  type RootEmployeeProvisioningSession,
} from "./claims-risk-dispatcher";
import type {
  EnqueueResult,
  TriggerDelivery,
  TriggerEnvelope,
  TriggerHandler,
  TriggerSession,
} from "./employee-trigger-runtime";

function fakeQueue(
  respond: (delivery: TriggerDelivery) => Promise<EnqueueResult>,
): { queue: ClaimsRiskTriggerQueue; deliveries: TriggerDelivery[] } {
  const deliveries: TriggerDelivery[] = [];
  return {
    deliveries,
    queue: {
      async enqueue(delivery: TriggerDelivery) {
        deliveries.push(delivery);
        return respond(delivery);
      },
      async reconcile() {
        return { scanned: 0, reclaimed: 0, completed: 0, waiting: 0, failed: 0 };
      },
    },
  };
}

function captureHandler(): {
  runtime: { registerHandler(reason: string, handler: TriggerHandler): void };
  run: (trigger: Partial<TriggerEnvelope>, session: TriggerSession) => Promise<unknown>;
} {
  let handler: TriggerHandler | undefined;
  return {
    runtime: {
      registerHandler(_reason, h) {
        handler = h;
      },
    },
    async run(trigger, session) {
      if (!handler) throw new Error("handler not registered");
      return handler({
        trigger: {
          id: "employee_trigger:t1",
          database: "ws_a",
          employeeId: "user:claims_risk_reminder",
          reason: CLAIMS_RISK_REASON,
          payloadRef: null,
          chainDepth: 0,
          idempotencyKey: "k",
          ...trigger,
        },
        session,
        // VER04 handler ctx：测试直接透传 effect（不写账本）与不可用的 suspend。
        effects: { runEffect: (_key, fn) => fn() },
        suspend: async () => {
          throw new Error("suspend not supported in test");
        },
      });
    },
  };
}

describe("OIP-18 风险提醒 trigger adapter", () => {
  test("没有专用虚拟员工时以 root 仅创建身份和凭证，并返回后续投递所需目标", async () => {
    let hasEmployee = false;
    let secret: string | undefined;
    const root: RootEmployeeProvisioningSession = {
      async query(sql, params) {
        if (sql.includes("FROM user:claims_risk_reminder")) {
          return hasEmployee ? [{ id: "user:claims_risk_reminder", subject: "claims-risk-reminder" }] : [];
        }
        if (sql.includes("CREATE user:claims_risk_reminder")) {
          hasEmployee = true;
          return [];
        }
        if (sql.includes("FROM employee_credential")) {
          return secret ? [{ secret }] : [];
        }
        if (sql.includes("INSERT INTO employee_credential")) {
          secret = String(params?.secret);
          return [];
        }
        return [];
      },
    };

    expect(await ensureClaimsRiskEmployee(root, () => "generated-secret")).toEqual({
      employeeId: "user:claims_risk_reminder",
      subject: "claims-risk-reminder",
      secret: "generated-secret",
    });
  });

  test("dispatch 为每个 workspace 投递持久化触发，幂等键含员工与日期", async () => {
    const { queue, deliveries } = fakeQueue(async () => ({
      outcome: "completed",
      triggerId: "employee_trigger:t1",
    }));
    const result = await runClaimsRiskReminderDispatch({
      now: () => new Date("2026-09-30T01:00:00.000Z"),
      listEmployees: async () => [
        { database: "ws_alpha", employeeId: "user:claims_risk_reminder" },
        { database: "ws_beta", employeeId: "user:claims_risk_reminder" },
      ],
      triggerRuntime: queue,
    });

    expect(result).toEqual({ targets: 2, completed: 2, coalesced: 0, failed: 0 });
    expect(deliveries).toEqual([
      {
        database: "ws_alpha",
        employeeId: "user:claims_risk_reminder",
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        chainDepth: 0,
        idempotencyKey: "daily-claims-risk:user:claims_risk_reminder:2026-09-30",
      },
      {
        database: "ws_beta",
        employeeId: "user:claims_risk_reminder",
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        chainDepth: 0,
        idempotencyKey: "daily-claims-risk:user:claims_risk_reminder:2026-09-30",
      },
    ]);
  });

  test("同一工作区同一天重复投递由 runtime 收敛为 coalesced，不再产生第二次检查", async () => {
    const { queue } = fakeQueue(async () => ({
      outcome: "coalesced",
      triggerId: "employee_trigger:t1",
    }));
    const result = await runClaimsRiskReminderDispatch({
      now: () => new Date("2026-09-30T01:00:00.000Z"),
      listEmployees: async () => [{ database: "ws_alpha", employeeId: "user:claims_risk_reminder" }],
      triggerRuntime: queue,
    });
    expect(result).toEqual({ targets: 1, completed: 0, coalesced: 1, failed: 0 });
  });

  test("投递被拒或执行失败计入 failed，其余目标不受影响", async () => {
    const { queue } = fakeQueue(async (delivery) => {
      if (delivery.database === "ws_bad") throw new Error("employee-trigger-runtime-stopped");
      return { outcome: "failed", error: "no such employee" };
    });
    const result = await runClaimsRiskReminderDispatch({
      now: () => new Date("2026-09-30T01:00:00.000Z"),
      listEmployees: async () => [
        { database: "ws_bad", employeeId: "user:claims_risk_reminder" },
        { database: "ws_ok", employeeId: "user:claims_risk_reminder" },
      ],
      triggerRuntime: queue,
    });
    expect(result).toEqual({ targets: 2, completed: 0, coalesced: 0, failed: 2 });
  });

  test("handler 用触发的 payloadRef 作为 checkDate，以员工会话跑既有检查逻辑", async () => {
    const { runtime, run } = captureHandler();
    const calls: string[] = [];
    const store: ClaimsRiskStore = {
      async loadEnabledWorkbooks() {
        calls.push("load-workbooks");
        return [];
      },
      async beginDailyRun() {
        throw new Error("must not begin: not-enabled returns early");
      },
      async loadSheetRecords() { return []; },
      async saveReminder() { return false; },
      async completeDailyRun() {},
      async failDailyRun() {},
    };
    registerClaimsRiskHandler(runtime, {
      now: () => new Date("2026-09-30T02:00:00.000Z"),
      storeFor: () => {
        calls.push("store-for");
        return store;
      },
    });

    const session: TriggerSession = { query: async () => [[]] };
    const result = await run({ payloadRef: "2026-09-30" }, session);
    expect(result).toEqual({ status: "not-enabled", remindersCreated: 0 });
    expect(calls).toEqual(["store-for", "load-workbooks"]);
  });
});
