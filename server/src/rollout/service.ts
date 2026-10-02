import {
  ROLLOUT_GATES,
  ROLLOUT_GATE_LABELS,
  type RegisterRolloutBatch,
  type RolloutBatchView,
  type RolloutGateKey,
  type RolloutGateState,
  type RolloutGateView,
  type RolloutOperationKind,
  type RolloutOperationView,
  type SetWorkspaceRolloutGate,
  type UpdateRolloutBatchStatus,
  type WorkspaceRolloutStatus,
} from "@surreal-ck/shared";

export class RolloutError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "conflict" | "invalid_request" | "scope_denied",
    message: string,
  ) {
    super(message);
    this.name = "RolloutError";
  }
}

export type RolloutActor = { subject: string; capabilities: readonly string[] };

export type WorkspaceGateRow = {
  id: string;
  workspaceId: string;
  gate: RolloutGateKey;
  state: RolloutGateState;
  revision: number;
  reason: string;
  batchKey: string | null;
  updatedBy: string;
  updatedAt: string;
};

export type RolloutOperationRow = {
  id: string;
  kind: RolloutOperationKind;
  gate: RolloutGateKey | null;
  workspaceId: string | null;
  workspaceSlug: string | null;
  batchKey: string | null;
  actorSubject: string;
  capability: string;
  reason: string;
  requestDigest: string;
  idempotencyKey: string;
  beforeState: string | null;
  afterState: string | null;
  beforeRevision: number | null;
  afterRevision: number | null;
  correlationId: string;
  occurredAt: string;
};

export type RolloutBatchRow = Omit<RolloutBatchView, never> & { requestDigest: string };

export type RolloutWorkspaceRef = { id: string; slug: string; dbName: string };

export interface RolloutStore {
  workspaceBySlug(slug: string): Promise<RolloutWorkspaceRef | null>;
  gateRow(workspaceId: string, gate: RolloutGateKey): Promise<WorkspaceGateRow | null>;
  gateRows(workspaceId: string): Promise<WorkspaceGateRow[]>;
  /**
   * CAS 应用开关状态：expectedRevision=0 时插入（唯一键冲突 → raced）；
   * 否则 UPDATE ... WHERE revision = expectedRevision（0 行 → raced）。
   */
  applyGateState(input: {
    workspaceId: string;
    gate: RolloutGateKey;
    expectedRevision: number;
    state: RolloutGateState;
    revision: number;
    reason: string;
    batchKey: string | null;
    actor: string;
  }): Promise<"ok" | "raced">;
  operationByKey(actor: string, idempotencyKey: string): Promise<RolloutOperationRow | null>;
  insertOperation(row: Omit<RolloutOperationRow, "id" | "occurredAt">): Promise<"ok" | "conflict">;
  operationsForWorkspace(workspaceId: string, limit: number): Promise<RolloutOperationRow[]>;
  batchByKey(batchKey: string): Promise<RolloutBatchRow | null>;
  /** status 恒由 "draft" 起步；created_at 由库内 DEFAULT 产生。 */
  insertBatch(row: {
    batchKey: string;
    label: string;
    appRelease: string;
    idpRelease: string;
    schemaRevision: string;
    legalSources: RolloutBatchView["legalSources"];
    planMapping: RolloutBatchView["planMapping"];
    allowedWorkspaces: string[];
    gaps: string[];
    reason: string;
    createdBy: string;
    requestDigest: string;
  }): Promise<"ok" | "conflict">;
  /** CAS 批次状态流转：WHERE batch_key AND status = expectedStatus。 */
  transitionBatch(input: {
    batchKey: string;
    expectedStatus: "draft" | "active";
    status: "active" | "closed";
    actor: string;
    reason: string;
  }): Promise<"ok" | "raced" | "missing">;
  listBatches(limit: number): Promise<RolloutBatchRow[]>;
  /** 覆盖 slug 的 active 批次 key（restore 的受控名单来源）。 */
  activeBatchesForSlug(slug: string): Promise<string[]>;
}

function denyUnless(actor: RolloutActor, capability: string): void {
  if (!actor.capabilities.includes(capability)) throw new RolloutError("forbidden", "缺少运营能力");
}

const digestOf = (value: unknown): string => JSON.stringify(value);

function gateView(row: WorkspaceGateRow | null, gate: RolloutGateKey): RolloutGateView {
  return {
    gate,
    label: ROLLOUT_GATE_LABELS[gate],
    state: row?.state ?? "enabled",
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    reason: row?.reason ?? null,
    batchKey: row?.batchKey ?? null,
  };
}

function operationView(row: RolloutOperationRow): RolloutOperationView {
  return {
    id: row.id,
    kind: row.kind,
    gate: row.gate,
    workspaceSlug: row.workspaceSlug,
    batchKey: row.batchKey,
    actorSubject: row.actorSubject,
    capability: row.capability,
    reason: row.reason,
    beforeState: (row.beforeState as RolloutOperationView["beforeState"]) ?? null,
    afterState: (row.afterState as RolloutOperationView["afterState"]) ?? null,
    beforeRevision: row.beforeRevision,
    afterRevision: row.afterRevision,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    occurredAt: row.occurredAt,
  };
}

function batchView(row: RolloutBatchRow): RolloutBatchView {
  const { requestDigest: _digest, ...view } = row;
  return view;
}

/**
 * LCA14 受控灰度开关服务。
 *
 * 事件先行（actor+idempotencyKey 唯一占位）再 CAS 应用状态：重放同键同体 →
 * 校验收敛后直接返回既有结果；同键异体 → conflict。restore 只允许落在
 * active 批次受控名单内的 workspace——「受控名单仅 company 专用验收 workspace」
 * 由这条校验硬性落地，而不是靠操作者自律。
 */
export class RolloutGateService {
  constructor(private readonly store: RolloutStore) {}

  async workspaceStatus(actor: RolloutActor, workspaceSlug: string): Promise<WorkspaceRolloutStatus> {
    denyUnless(actor, "quota.read");
    const workspace = await this.store.workspaceBySlug(workspaceSlug);
    if (!workspace) throw new RolloutError("not_found", "工作区不存在");
    const [rows, activeBatches, operations] = await Promise.all([
      this.store.gateRows(workspace.id),
      this.store.activeBatchesForSlug(workspace.slug),
      this.store.operationsForWorkspace(workspace.id, 25),
    ]);
    const byGate = new Map(rows.map((row) => [row.gate, row]));
    return {
      workspaceSlug: workspace.slug,
      gates: ROLLOUT_GATES.map((gate) => gateView(byGate.get(gate) ?? null, gate)),
      activeBatches,
      recentOperations: operations.map(operationView),
    };
  }

  async listBatches(actor: RolloutActor, limit = 50): Promise<RolloutBatchView[]> {
    denyUnless(actor, "quota.read");
    return (await this.store.listBatches(limit)).map(batchView);
  }

  async getBatch(actor: RolloutActor, batchKey: string): Promise<RolloutBatchView> {
    denyUnless(actor, "quota.read");
    const batch = await this.store.batchByKey(batchKey);
    if (!batch) throw new RolloutError("not_found", "批次不存在");
    return batchView(batch);
  }

  async setGate(actor: RolloutActor, workspaceSlug: string, input: SetWorkspaceRolloutGate): Promise<RolloutGateView> {
    denyUnless(actor, "rollout.manage");
    const requestDigest = digestOf({ workspaceSlug, ...input });
    const workspace = await this.store.workspaceBySlug(workspaceSlug);
    if (!workspace) throw new RolloutError("not_found", "工作区不存在");

    const prior = await this.store.operationByKey(actor.subject, input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new RolloutError("conflict", "幂等键已用于其他请求");
      return await this.convergeReplay(workspace, input.gate, prior);
    }

    if (input.action === "restore") {
      // 恢复受控名单：目标必须在至少一个 active 批次内；disable 不受限（关停永远安全）。
      const active = await this.store.activeBatchesForSlug(workspace.slug);
      if (active.length === 0) {
        throw new RolloutError("scope_denied", "工作区不在任何 active 批次受控名单内，拒绝恢复");
      }
    }

    const before = await this.store.gateRow(workspace.id, input.gate);
    const beforeState: RolloutGateState = before?.state ?? "enabled";
    const beforeRevision = before?.revision ?? 0;
    const afterState: RolloutGateState = input.action === "disable" ? "disabled" : "enabled";
    const afterRevision = beforeRevision + 1;
    const kind: RolloutOperationKind = input.action === "disable" ? "gate_disable" : "gate_restore";

    const claimed = await this.store.insertOperation({
      kind,
      gate: input.gate,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      batchKey: input.batchKey ?? null,
      actorSubject: actor.subject,
      capability: "rollout.manage",
      reason: input.reason,
      requestDigest,
      idempotencyKey: input.idempotencyKey,
      beforeState,
      afterState,
      beforeRevision,
      afterRevision,
      correlationId: input.idempotencyKey,
    });
    if (claimed === "conflict") {
      const again = await this.store.operationByKey(actor.subject, input.idempotencyKey);
      if (!again || again.requestDigest !== requestDigest) {
        throw new RolloutError("conflict", "幂等键已用于其他请求");
      }
      return await this.convergeReplay(workspace, input.gate, again);
    }

    await this.applyOrConflict(workspace, input.gate, {
      expectedRevision: beforeRevision,
      state: afterState,
      revision: afterRevision,
      reason: input.reason,
      batchKey: input.batchKey ?? null,
      actor: actor.subject,
    });
    const row = await this.store.gateRow(workspace.id, input.gate);
    return gateView(row, input.gate);
  }

  /**
   * 幂等重放：事件已占位但状态可能未应用（事件中崩溃）。按事件声明的
   * before/after 收敛——当前已是 after 态直接返回；仍停在 before 态则补应用；
   * 已被其他操作推进 → conflict（不覆盖他人操作）。
   */
  private async convergeReplay(
    workspace: RolloutWorkspaceRef,
    gate: RolloutGateKey,
    event: RolloutOperationRow,
  ): Promise<RolloutGateView> {
    const row = await this.store.gateRow(workspace.id, gate);
    const currentState = row?.state ?? "enabled";
    const currentRevision = row?.revision ?? 0;
    if (currentState === event.afterState && currentRevision === event.afterRevision) {
      return gateView(row, gate);
    }
    if (currentRevision === event.beforeRevision) {
      await this.applyOrConflict(workspace, gate, {
        expectedRevision: event.beforeRevision ?? 0,
        state: event.afterState as RolloutGateState,
        revision: event.afterRevision ?? (event.beforeRevision ?? 0) + 1,
        reason: event.reason,
        batchKey: event.batchKey,
        actor: event.actorSubject,
      });
      const applied = await this.store.gateRow(workspace.id, gate);
      return gateView(applied, gate);
    }
    throw new RolloutError("conflict", "开关状态已被其他操作推进，本次重放不再适用");
  }

  private async applyOrConflict(
    workspace: RolloutWorkspaceRef,
    gate: RolloutGateKey,
    input: {
      expectedRevision: number;
      state: RolloutGateState;
      revision: number;
      reason: string;
      batchKey: string | null;
      actor: string;
    },
  ): Promise<void> {
    const applied = await this.store.applyGateState({ workspaceId: workspace.id, gate, ...input });
    if (applied === "raced") throw new RolloutError("conflict", "开关被并发修改，请重查状态后重试");
  }

  async registerBatch(actor: RolloutActor, input: RegisterRolloutBatch): Promise<RolloutBatchView> {
    denyUnless(actor, "rollout.manage");
    const requestDigest = digestOf(input);
    const prior = await this.store.operationByKey(actor.subject, input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new RolloutError("conflict", "幂等键已用于其他请求");
      const existing = await this.store.batchByKey(input.batchKey);
      if (!existing) throw new RolloutError("conflict", "批次登记事件存在但批次缺失");
      return batchView(existing);
    }
    const existing = await this.store.batchByKey(input.batchKey);
    if (existing) {
      if (existing.requestDigest === requestDigest) return batchView(existing);
      throw new RolloutError("conflict", "批次名已存在且内容不一致，请使用新批次名");
    }
    const claimed = await this.store.insertOperation({
      kind: "batch_register",
      gate: null,
      workspaceId: null,
      workspaceSlug: null,
      batchKey: input.batchKey,
      actorSubject: actor.subject,
      capability: "rollout.manage",
      reason: input.reason,
      requestDigest,
      idempotencyKey: input.idempotencyKey,
      beforeState: null,
      afterState: "draft",
      beforeRevision: null,
      afterRevision: null,
      correlationId: input.idempotencyKey,
    });
    if (claimed === "conflict") {
      const again = await this.store.operationByKey(actor.subject, input.idempotencyKey);
      if (!again || again.requestDigest !== requestDigest) {
        throw new RolloutError("conflict", "幂等键已用于其他请求");
      }
      const batch = await this.store.batchByKey(input.batchKey);
      if (!batch) throw new RolloutError("conflict", "批次登记事件存在但批次缺失");
      return batchView(batch);
    }
    const inserted = await this.store.insertBatch({
      batchKey: input.batchKey,
      label: input.label,
      appRelease: input.appRelease,
      idpRelease: input.idpRelease,
      schemaRevision: input.schemaRevision,
      legalSources: input.legalSources.map((s) => ({ ...s })),
      planMapping: input.planMapping.map((p) => ({ ...p })),
      allowedWorkspaces: [...new Set(input.allowedWorkspaces)],
      gaps: [...input.gaps],
      reason: input.reason,
      createdBy: actor.subject,
      requestDigest,
    });
    if (inserted === "conflict") {
      const raced = await this.store.batchByKey(input.batchKey);
      if (raced && raced.requestDigest === requestDigest) return batchView(raced);
      throw new RolloutError("conflict", "批次名已存在且内容不一致，请使用新批次名");
    }
    const batch = await this.store.batchByKey(input.batchKey);
    if (!batch) throw new RolloutError("conflict", "批次写入后不可读");
    return batchView(batch);
  }

  async transitionBatch(
    actor: RolloutActor,
    batchKey: string,
    input: UpdateRolloutBatchStatus,
  ): Promise<RolloutBatchView> {
    denyUnless(actor, "rollout.manage");
    const requestDigest = digestOf({ batchKey, ...input });
    const prior = await this.store.operationByKey(actor.subject, input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new RolloutError("conflict", "幂等键已用于其他请求");
      const existing = await this.store.batchByKey(batchKey);
      if (!existing) throw new RolloutError("not_found", "批次不存在");
      return batchView(existing);
    }
    const batch = await this.store.batchByKey(batchKey);
    if (!batch) throw new RolloutError("not_found", "批次不存在");
    if (batch.status === "closed") throw new RolloutError("conflict", "批次已关闭，不可再流转");
    if (batch.status === "active" && input.status === "active") {
      throw new RolloutError("conflict", "批次已是 active");
    }
    const kind: RolloutOperationKind = input.status === "active" ? "batch_activate" : "batch_close";
    const claimed = await this.store.insertOperation({
      kind,
      gate: null,
      workspaceId: null,
      workspaceSlug: null,
      batchKey,
      actorSubject: actor.subject,
      capability: "rollout.manage",
      reason: input.reason,
      requestDigest,
      idempotencyKey: input.idempotencyKey,
      beforeState: batch.status,
      afterState: input.status,
      beforeRevision: null,
      afterRevision: null,
      correlationId: input.idempotencyKey,
    });
    if (claimed === "conflict") {
      const again = await this.store.operationByKey(actor.subject, input.idempotencyKey);
      if (!again || again.requestDigest !== requestDigest) {
        throw new RolloutError("conflict", "幂等键已用于其他请求");
      }
      const existing = await this.store.batchByKey(batchKey);
      if (!existing) throw new RolloutError("not_found", "批次不存在");
      return batchView(existing);
    }
    const applied = await this.store.transitionBatch({
      batchKey,
      expectedStatus: batch.status as "draft" | "active",
      status: input.status,
      actor: actor.subject,
      reason: input.reason,
    });
    if (applied !== "ok") throw new RolloutError("conflict", "批次状态被并发修改，请重查后重试");
    const updated = await this.store.batchByKey(batchKey);
    if (!updated) throw new RolloutError("not_found", "批次不存在");
    return batchView(updated);
  }

  /** 发布门槛事实：全部具名 gate 目录（固定两枚，扩列须发版）。 */
  gateCatalog(): { gate: RolloutGateKey; label: string }[] {
    return ROLLOUT_GATES.map((gate) => ({ gate, label: ROLLOUT_GATE_LABELS[gate] }));
  }
}
