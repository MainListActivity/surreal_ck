import { DateTime } from "surrealdb";
import {
  getRootDatabaseSession,
  getStableRootConnection,
  probeRootConnectionAfterWorkerError,
} from "../db/root-connection";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { AiAllowancePlanCycleSynchronizer } from "../ai-allowance/plan-cycle";
import { ProductEntitlementService } from "../product-entitlement/service";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";
import { SurrealLifecycleBoundarySweepHandler } from "./lifecycle-sweep";
import { QuotaReconciler } from "./reconciler";
import { QuotaLifecycleCoordinator } from "./subscription-lifecycle";
import { SubscriptionEntitlementCascade } from "./subscription-cascade";
import {
  ControlPlaneSweep,
  MaterializationWorker,
  NativeAuditSweep,
  startQuotaLoop,
  type QuotaLoopHandle,
} from "./sweeps";
import { SurrealQuotaAuthorityReader } from "./quota-authority-reader";
import {
  QuotaObservationService,
  SurrealQuotaObservationStore,
} from "./quota-observation";
import { SurrealNativeAuditSweepHandler } from "./native-audit-sweep";
import { SurrealQuotaOperatorMaintenance } from "./operator-maintenance";
import { getWorkerLivenessSnapshot } from "./worker-liveness";

const EVENT_INTERVAL_MS = 250;
const MATERIALIZATION_INTERVAL_MS = 250;
const BOUNDARY_INTERVAL_MS = 60_000;
const NATIVE_AUDIT_INTERVAL_MS = 10_000;
/** 心跳落库节流：正常每环 ≥5s 一次，报错立即（≥1s 节流）。 */
const HEARTBEAT_THROTTLE_MS = 5_000;
const HEARTBEAT_ERROR_THROTTLE_MS = 1_000;

export type NativeQuotaRuntimeHandle = Readonly<{ stop(): void }>;

function reportLoopError(loop: string, error: unknown): void {
  console.error("[quota] runtime loop failed; next tick will retry", {
    loop,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}

function epochMsToDateTime(epochMs: number | null): DateTime | undefined {
  return epochMs === null
    ? undefined
    : DateTime.fromEpochNanoseconds(BigInt(epochMs) * 1_000_000n);
}

function livenessOf(loop: string) {
  return getWorkerLivenessSnapshot().loops.find(
    (entry) => entry.loop === loop,
  );
}

/**
 * Loop 记录 id 固定（每环一行），跨重启覆盖而非累积；
 * 只含计数/时间/错误码，不含载荷与用户内容。
 */
const HEARTBEAT_RECORD_IDS: Readonly<Record<string, string>> = Object.freeze({
  "provider-events": "provider_events",
  "operator-intents": "operator_intents",
  "materialization": "materialization",
  "lifecycle-boundaries": "boundary_sweep",
  "native-audit": "native_audit",
});

class WorkerHeartbeatWriter {
  private lastWriteAt = new Map<string, number>();

  constructor(
    private readonly db: {
      query<T = unknown>(
        sql: string,
        params?: Record<string, unknown>,
      ): Promise<T>;
    },
    private readonly workerId: string,
  ) {}

  /** 成功心跳按节流落库；报错心跳用更短节流尽量不丢最近失败状态。 */
  write(loop: string, kind: "success" | "error"): void {
    const now = Date.now();
    const throttle = kind === "error"
      ? HEARTBEAT_ERROR_THROTTLE_MS
      : HEARTBEAT_THROTTLE_MS;
    const last = this.lastWriteAt.get(loop) ?? 0;
    if (now - last < throttle) return;
    this.lastWriteAt.set(loop, now);
    void this.persist(loop).catch(() => undefined);
  }

  private async persist(loop: string): Promise<void> {
    const record = HEARTBEAT_RECORD_IDS[loop];
    if (!record) return;
    const snapshot = livenessOf(loop);
    if (!snapshot) return;
    // 稳定引用：重连后心跳也打到当前连接。
    await this.db.query(
      `
        UPSERT type::record("quota_worker_heartbeat", $recordId) CONTENT {
          loop: $loop,
          worker_id: $worker,
          tick_count: $ticks,
          consecutive_errors: $consecutiveErrors,
          timeouts: $timeouts,
          last_tick_at: $lastTickAt,
          last_success_at: $lastSuccessAt,
          last_error_code: $lastErrorCode,
          last_error_at: $lastErrorAt
        };
      `,
      {
        recordId: record,
        loop,
        worker: this.workerId,
        ticks: snapshot.ticks,
        consecutiveErrors: snapshot.consecutiveErrors,
        timeouts: snapshot.timeouts,
        lastTickAt: epochMsToDateTime(
          snapshot.secondsSinceLastTick === null
            ? null
            : Date.now()
              - Math.round(snapshot.secondsSinceLastTick * 1000),
        ),
        lastSuccessAt: epochMsToDateTime(
          snapshot.secondsSinceLastSuccess === null
            ? null
            : Date.now()
              - Math.round(snapshot.secondsSinceLastSuccess * 1000),
        ),
        lastErrorCode: snapshot.lastError ?? undefined,
        lastErrorAt: epochMsToDateTime(snapshot.lastErrorAt),
      },
    );
  }
}

/**
 * Starts the durable control-plane consumers after schema migration and plan
 * seeding. Every loop is restart-safe because claims, leases, cursors and
 * idempotency keys live in `_system`. The root connection is resolved per
 * query through a stable reference: after a disconnect + reconnect the very
 * next tick goes to the new connection instead of a closed stale instance.
 */
export function startNativeQuotaRuntime(): NativeQuotaRuntimeHandle {
  const db = getStableRootConnection();
  const workerId = `quota:${process.pid}:${crypto.randomUUID()}`;
  const controlStore = new SurrealQuotaControlPlaneStore(db);
  const lifecycleStore = new SurrealQuotaLifecycleStore(db);
  // LCA08：native 刷新完成后由级联重算产品权益快照并同步 AI 周期额度。
  const refresher = new SubscriptionEntitlementCascade(
    new SurrealEntitlementRefreshService(db),
    new ProductEntitlementService(new SurrealProductEntitlementStore()),
    new AiAllowancePlanCycleSynchronizer({
      workspaceSession: (database) => getRootDatabaseSession(database),
    }),
  );
  const nativeClient = new SurrealNativeQuotaClient(db);
  const reconciler = new QuotaReconciler(
    controlStore,
    nativeClient,
  );
  const materializationWorker = new MaterializationWorker(
    controlStore,
    reconciler,
    `${workerId}:materialization`,
  );
  const wakeMaterialization = () => {
    void materializationWorker.runOnce().catch((error) =>
      reportLoopError("materialization-wake", error)
    );
  };
  const authorityReader = new SurrealQuotaAuthorityReader({ db });
  const observations = new QuotaObservationService(
    new SurrealQuotaObservationStore({ db }),
  );
  const lifecycle = new QuotaLifecycleCoordinator(
    lifecycleStore,
    refresher,
    `${workerId}:lifecycle`,
    { wake: wakeMaterialization },
    {
      operatorMaintenance: new SurrealQuotaOperatorMaintenance(
        db,
        authorityReader,
        nativeClient,
        observations,
      ),
    },
  );
  const boundarySweep = new ControlPlaneSweep(
    controlStore,
    new SurrealLifecycleBoundarySweepHandler(db, refresher),
    `${workerId}:boundary`,
  );
  const nativeAudit = new NativeAuditSweep(
    controlStore,
    new SurrealNativeAuditSweepHandler(
      db,
      authorityReader,
      nativeClient,
      observations,
    ),
    `${workerId}:native-audit`,
  );
  const heartbeat = new WorkerHeartbeatWriter(db, workerId);
  const loopError = (loop: string) => (error: unknown) => {
    reportLoopError(loop, error);
    heartbeat.write(loop, "error");
    // 报错可能意味着连接半开：节流探针兜底触发重连。
    probeRootConnectionAfterWorkerError();
  };
  const loops: QuotaLoopHandle[] = [
    startQuotaLoop({
      name: "provider-events",
      runOnce: () => lifecycle.processNextProviderEvent(),
      intervalMs: EVENT_INTERVAL_MS,
      onError: loopError("provider-events"),
      onSuccess: () => heartbeat.write("provider-events", "success"),
    }),
    startQuotaLoop({
      name: "operator-intents",
      runOnce: () => lifecycle.processNextOperatorIntent(),
      intervalMs: EVENT_INTERVAL_MS,
      onError: loopError("operator-intents"),
      onSuccess: () => heartbeat.write("operator-intents", "success"),
    }),
    startQuotaLoop({
      name: "materialization",
      runOnce: () => materializationWorker.runOnce(),
      intervalMs: MATERIALIZATION_INTERVAL_MS,
      onError: loopError("materialization"),
      onSuccess: () => heartbeat.write("materialization", "success"),
    }),
    startQuotaLoop({
      name: "lifecycle-boundaries",
      async runOnce() {
        const result = await boundarySweep.runOnce();
        if (
          result.kind === "checkpointed"
          && result.processed > 0
        ) {
          wakeMaterialization();
        }
        return result;
      },
      intervalMs: BOUNDARY_INTERVAL_MS,
      onError: loopError("lifecycle-boundaries"),
      onSuccess: () => heartbeat.write("lifecycle-boundaries", "success"),
    }),
    startQuotaLoop({
      name: "native-audit",
      runOnce: () => nativeAudit.runOnce(),
      intervalMs: NATIVE_AUDIT_INTERVAL_MS,
      onError: loopError("native-audit"),
      onSuccess: () => heartbeat.write("native-audit", "success"),
    }),
  ];
  for (const loop of [
    "provider-events",
    "operator-intents",
    "materialization",
    "lifecycle-boundaries",
    "native-audit",
  ]) {
    // 首个 tick 之后落一次基线心跳（成功或失败由 liveness 记账决定）。
    heartbeat.write(loop, "success");
  }
  return Object.freeze({
    stop() {
      for (const loop of loops) loop.stop();
    },
  });
}
