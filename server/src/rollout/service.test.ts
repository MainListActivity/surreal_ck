import { describe, expect, test } from "bun:test";
import type {
  RegisterRolloutBatch,
  SetWorkspaceRolloutGate,
  UpdateRolloutBatchStatus,
} from "@surreal-ck/shared";
import {
  RolloutGateService,
  type RolloutActor,
  type RolloutBatchRow,
  type RolloutOperationRow,
  type RolloutStore,
  type RolloutWorkspaceRef,
  type WorkspaceGateRow,
} from "./service";

/**
 * RolloutStore 内存替身：与 SurrealRolloutStore 同一契约（唯一键冲突、CAS 语义），
 * 让 service 测试覆盖并发/重放分支而不依赖真实库。
 */
class MemStore implements RolloutStore {
  workspaces = new Map<string, RolloutWorkspaceRef>();
  gates = new Map<string, WorkspaceGateRow>();
  ops: RolloutOperationRow[] = [];
  batches = new Map<string, RolloutBatchRow>();
  private seq = 0;

  addWorkspace(slug: string): RolloutWorkspaceRef {
    const ref = { id: `workspace:${slug}`, slug, dbName: `ws_${slug}` };
    this.workspaces.set(slug, ref);
    return ref;
  }

  private gateKey(workspaceId: string, gate: string): string {
    return `${workspaceId}|${gate}`;
  }

  async workspaceBySlug(slug: string) {
    return this.workspaces.get(slug) ?? null;
  }

  async gateRow(workspaceId: string, gate: Parameters<RolloutStore["gateRow"]>[1]) {
    return this.gates.get(this.gateKey(workspaceId, gate)) ?? null;
  }

  async gateRows(workspaceId: string) {
    return [...this.gates.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async applyGateState(input: Parameters<RolloutStore["applyGateState"]>[0]) {
    const key = this.gateKey(input.workspaceId, input.gate);
    const current = this.gates.get(key);
    if (input.expectedRevision === 0) {
      if (current) return "raced";
    } else if (!current || current.revision !== input.expectedRevision) {
      return "raced";
    }
    this.gates.set(key, {
      id: key,
      workspaceId: input.workspaceId,
      gate: input.gate,
      state: input.state,
      revision: input.revision,
      reason: input.reason,
      batchKey: input.batchKey,
      updatedBy: input.actor,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return "ok";
  }

  async operationByKey(actor: string, idempotencyKey: string) {
    return this.ops.find((op) => op.actorSubject === actor && op.idempotencyKey === idempotencyKey) ?? null;
  }

  async insertOperation(row: Omit<RolloutOperationRow, "id" | "occurredAt">) {
    const dupe = this.ops.some((op) => op.actorSubject === row.actorSubject && op.idempotencyKey === row.idempotencyKey);
    if (dupe) return "conflict";
    this.seq += 1;
    this.ops.push({ ...row, id: `rollout_operation:${this.seq}`, occurredAt: "2026-01-01T00:00:00.000Z" });
    return "ok";
  }

  async operationsForWorkspace(workspaceId: string, limit: number) {
    return this.ops.filter((op) => op.workspaceId === workspaceId).slice(0, limit);
  }

  async batchByKey(batchKey: string) {
    return this.batches.get(batchKey) ?? null;
  }

  async insertBatch(row: Parameters<RolloutStore["insertBatch"]>[0]) {
    if (this.batches.has(row.batchKey)) return "conflict";
    this.batches.set(row.batchKey, {
      batchKey: row.batchKey,
      label: row.label,
      status: "draft",
      appRelease: row.appRelease,
      idpRelease: row.idpRelease,
      schemaRevision: row.schemaRevision,
      legalSources: row.legalSources,
      planMapping: row.planMapping,
      allowedWorkspaces: row.allowedWorkspaces,
      gaps: row.gaps,
      reason: row.reason,
      createdBy: row.createdBy,
      createdAt: "2026-01-01T00:00:00.000Z",
      activatedBy: null,
      activatedAt: null,
      closedBy: null,
      closedAt: null,
      closeReason: null,
      requestDigest: row.requestDigest,
    });
    return "ok";
  }

  async transitionBatch(input: Parameters<RolloutStore["transitionBatch"]>[0]) {
    const batch = this.batches.get(input.batchKey);
    if (!batch) return "missing";
    if (batch.status !== input.expectedStatus) return "raced";
    this.batches.set(input.batchKey, {
      ...batch,
      status: input.status,
      ...(input.status === "active"
        ? { activatedBy: input.actor, activatedAt: "2026-01-01T00:00:01.000Z" }
        : { closedBy: input.actor, closedAt: "2026-01-01T00:00:01.000Z", closeReason: input.reason }),
    });
    return "ok";
  }

  async listBatches(limit: number) {
    return [...this.batches.values()].slice(0, limit);
  }

  async activeBatchesForSlug(slug: string) {
    return [...this.batches.values()]
      .filter((b) => b.status === "active" && b.allowedWorkspaces.includes(slug))
      .map((b) => b.batchKey);
  }
}

const ops: RolloutActor = { subject: "ops-1", capabilities: ["quota.read", "rollout.manage"] };
const readOnly: RolloutActor = { subject: "ops-2", capabilities: ["quota.read"] };
const noCaps: RolloutActor = { subject: "ops-3", capabilities: [] };

const gateInput = (overrides: Partial<SetWorkspaceRolloutGate> = {}): SetWorkspaceRolloutGate => ({
  gate: "legal_content_access",
  action: "disable",
  reason: "LCA14 验收演练",
  idempotencyKey: "idem-key-0001",
  ...overrides,
});

const batchInput = (overrides: Partial<RegisterRolloutBatch> = {}): RegisterRolloutBatch => ({
  batchKey: "lca14-qa-batch-1",
  label: "LCA14 验收批次一",
  appRelease: "81fdc1b",
  idpRelease: "ma_hono@1.2.3",
  schemaRevision: "system-028",
  legalSources: [{ sourceKey: "flk", label: "法规库", licenseNote: "商用许可协议 X-1" }],
  planMapping: [
    { planKey: "pro", displayName: "Pro", aiRate: "每 run 预留 1", trialAllowance: 50, legacySubscriptionMap: "quota_plan_revision:legacy:pro" },
  ],
  allowedWorkspaces: ["accept-a"],
  gaps: [],
  reason: "LCA14 首批受控验收",
  idempotencyKey: "batch-idem-0001",
  ...overrides,
});

const statusInput = (overrides: Partial<UpdateRolloutBatchStatus> = {}): UpdateRolloutBatchStatus => ({
  status: "active",
  reason: "灰度开启",
  idempotencyKey: "batch-act-0001",
  ...overrides,
});

describe("RolloutGateService 能力分权", () => {
  test("读接口要求 quota.read；写接口要求 rollout.manage", async () => {
    const service = new RolloutGateService(new MemStore());
    await expect(service.listBatches(noCaps)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.listBatches(readOnly)).resolves.toEqual([]);
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const svc = new RolloutGateService(store);
    await expect(svc.setGate(readOnly, "accept-a", gateInput())).rejects.toMatchObject({ code: "forbidden" });
    await expect(svc.registerBatch(readOnly, batchInput())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("RolloutGateService 开关切换", () => {
  test("disable 不依赖批次名单：无行 → 建 disabled 行并落审计事件", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const service = new RolloutGateService(store);
    const view = await service.setGate(ops, "accept-a", gateInput());
    expect(view).toMatchObject({ gate: "legal_content_access", state: "disabled", revision: 1, batchKey: null });
    expect(store.ops).toHaveLength(1);
    expect(store.ops[0]).toMatchObject({
      kind: "gate_disable",
      gate: "legal_content_access",
      workspaceSlug: "accept-a",
      actorSubject: "ops-1",
      capability: "rollout.manage",
      beforeState: "enabled",
      afterState: "disabled",
      beforeRevision: 0,
      afterRevision: 1,
    });
  });

  test("restore 无 active 批次覆盖 → scope_denied，不改状态", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const service = new RolloutGateService(store);
    await service.setGate(ops, "accept-a", gateInput());
    await expect(
      service.setGate(ops, "accept-a", gateInput({ action: "restore", idempotencyKey: "idem-restore-1" })),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect((await service.workspaceStatus(ops, "accept-a")).gates[0]?.state).toBe("disabled");
  });

  test("restore 仅放行 active 批次名单内 workspace；关闭批次的名单不再生效", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    store.addWorkspace("outside");
    const service = new RolloutGateService(store);
    await service.registerBatch(ops, batchInput());
    await service.transitionBatch(ops, "lca14-qa-batch-1", statusInput());

    // 名单外 workspace 仍被拒。
    await expect(
      service.setGate(ops, "outside", gateInput({ action: "restore", idempotencyKey: "idem-r-out" })),
    ).rejects.toMatchObject({ code: "scope_denied" });

    // 名单内 workspace：先 disable 再 restore。
    await service.setGate(ops, "accept-a", gateInput());
    const restored = await service.setGate(ops, "accept-a", gateInput({ action: "restore", idempotencyKey: "idem-r-1" }));
    expect(restored).toMatchObject({ state: "enabled", revision: 2 });
    const restoreOp = store.ops.find((op) => op.kind === "gate_restore");
    expect(restoreOp).toMatchObject({ afterState: "enabled", beforeRevision: 1, afterRevision: 2 });

    // 批次关闭后名单立即失效。
    await service.setGate(ops, "accept-a", gateInput({ idempotencyKey: "idem-d-2" }));
    await service.transitionBatch(ops, "lca14-qa-batch-1", statusInput({ status: "closed", idempotencyKey: "batch-close-1", reason: "批次收束" }));
    await expect(
      service.setGate(ops, "accept-a", gateInput({ action: "restore", idempotencyKey: "idem-r-2" })),
    ).rejects.toMatchObject({ code: "scope_denied" });
  });

  test("幂等：同键同体重放收敛返回；同键异体 conflict", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const service = new RolloutGateService(store);
    const first = await service.setGate(ops, "accept-a", gateInput());
    const replay = await service.setGate(ops, "accept-a", gateInput());
    expect(replay).toEqual(first);
    expect(store.ops).toHaveLength(1);
    await expect(
      service.setGate(ops, "accept-a", gateInput({ reason: "不同原因" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("并发覆盖：事件中崩溃后重放可补应用；状态已被他人推进则 conflict", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const service = new RolloutGateService(store);
    // 模拟“事件已占位、状态未应用”：直接写事件行。
    await store.insertOperation({
      kind: "gate_disable",
      gate: "legal_content_access",
      workspaceId: "workspace:accept-a",
      workspaceSlug: "accept-a",
      batchKey: null,
      actorSubject: "ops-1",
      capability: "rollout.manage",
      reason: "断点重放",
      requestDigest: JSON.stringify({ workspaceSlug: "accept-a", ...gateInput() }),
      idempotencyKey: "idem-key-0001",
      beforeState: "enabled",
      afterState: "disabled",
      beforeRevision: 0,
      afterRevision: 1,
      correlationId: "idem-key-0001",
    });
    const replay = await service.setGate(ops, "accept-a", gateInput());
    expect(replay).toMatchObject({ state: "disabled", revision: 1 });

    // 他人已把状态推进到 revision 2 后，陈旧事件重放 → conflict。
    await store.insertOperation({
      kind: "gate_disable",
      gate: "legal_research_ai",
      workspaceId: "workspace:accept-a",
      workspaceSlug: "accept-a",
      batchKey: null,
      actorSubject: "ops-1",
      capability: "rollout.manage",
      reason: "旧事件",
      requestDigest: JSON.stringify({ workspaceSlug: "accept-a", ...gateInput({ gate: "legal_research_ai", idempotencyKey: "idem-ai-1" }) }),
      idempotencyKey: "idem-ai-1",
      beforeState: "disabled",
      afterState: "disabled",
      beforeRevision: 4,
      afterRevision: 5,
      correlationId: "idem-ai-1",
    });
    await store.applyGateState({
      workspaceId: "workspace:accept-a", gate: "legal_research_ai",
      expectedRevision: 0, state: "disabled", revision: 9, reason: "raced", batchKey: null, actor: "ops-9",
    });
    await expect(
      service.setGate(ops, "accept-a", gateInput({ gate: "legal_research_ai", idempotencyKey: "idem-ai-1" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("不存在的 workspace → not_found", async () => {
    const service = new RolloutGateService(new MemStore());
    await expect(service.workspaceStatus(ops, "ghost")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.setGate(ops, "ghost", gateInput())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("RolloutGateService 具名批次", () => {
  test("register：新建 draft；同键同体幂等返回；同名异体 conflict", async () => {
    const service = new RolloutGateService(new MemStore());
    const batch = await service.registerBatch(ops, batchInput());
    expect(batch).toMatchObject({ batchKey: "lca14-qa-batch-1", status: "draft", createdBy: "ops-1" });
    const replay = await service.registerBatch(ops, batchInput());
    expect(replay).toEqual(batch);
    await expect(
      service.registerBatch(ops, batchInput({ label: "不同内容", idempotencyKey: "batch-idem-0002" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("transition：draft→active→closed；closed 终态拒绝再流转", async () => {
    const service = new RolloutGateService(new MemStore());
    await service.registerBatch(ops, batchInput());
    const active = await service.transitionBatch(ops, "lca14-qa-batch-1", statusInput());
    expect(active.status).toBe("active");
    expect(active.activatedBy).toBe("ops-1");
    await expect(service.transitionBatch(ops, "lca14-qa-batch-1", statusInput({ idempotencyKey: "x-2" })))
      .rejects.toMatchObject({ code: "conflict" });
    const closed = await service.transitionBatch(ops, "lca14-qa-batch-1", statusInput({ status: "closed", idempotencyKey: "x-3", reason: "结束" }));
    expect(closed).toMatchObject({ status: "closed", closedBy: "ops-1", closeReason: "结束" });
    await expect(service.transitionBatch(ops, "lca14-qa-batch-1", statusInput({ status: "closed", idempotencyKey: "x-4" })))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(service.transitionBatch(ops, "missing", statusInput({ idempotencyKey: "x-5" })))
      .rejects.toMatchObject({ code: "not_found" });
  });

  test("workspaceStatus：默认双 gate enabled、activeBatches 与最近操作可见", async () => {
    const store = new MemStore();
    store.addWorkspace("accept-a");
    const service = new RolloutGateService(store);
    await service.registerBatch(ops, batchInput());
    await service.transitionBatch(ops, "lca14-qa-batch-1", statusInput());
    await service.setGate(ops, "accept-a", gateInput({ gate: "legal_research_ai", idempotencyKey: "idem-ai-9" }));
    const status = await service.workspaceStatus(ops, "accept-a");
    expect(status.workspaceSlug).toBe("accept-a");
    expect(status.gates.map((g) => [g.gate, g.state])).toEqual([
      ["legal_content_access", "enabled"],
      ["legal_research_ai", "disabled"],
    ]);
    expect(status.activeBatches).toEqual(["lca14-qa-batch-1"]);
    expect(status.recentOperations.map((op) => op.kind)).toContain("gate_disable");
  });
});
