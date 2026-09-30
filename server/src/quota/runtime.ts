import { getRootConnection, getRootDatabaseSession } from "../db/root-connection";
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

const EVENT_INTERVAL_MS = 250;
const MATERIALIZATION_INTERVAL_MS = 250;
const BOUNDARY_INTERVAL_MS = 60_000;
const NATIVE_AUDIT_INTERVAL_MS = 10_000;

export type NativeQuotaRuntimeHandle = Readonly<{ stop(): void }>;

function reportLoopError(loop: string, error: unknown): void {
  console.error("[quota] runtime loop failed; next tick will retry", {
    loop,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * Starts the durable control-plane consumers after schema migration and plan
 * seeding. Every loop is restart-safe because claims, leases, cursors and
 * idempotency keys live in `_system`.
 */
export function startNativeQuotaRuntime(): NativeQuotaRuntimeHandle {
  const db = getRootConnection();
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
  const loops: QuotaLoopHandle[] = [
    startQuotaLoop({
      runOnce: () => lifecycle.processNextProviderEvent(),
      intervalMs: EVENT_INTERVAL_MS,
      onError: (error) => reportLoopError("provider-events", error),
    }),
    startQuotaLoop({
      runOnce: () => lifecycle.processNextOperatorIntent(),
      intervalMs: EVENT_INTERVAL_MS,
      onError: (error) => reportLoopError("operator-intents", error),
    }),
    startQuotaLoop({
      runOnce: () => materializationWorker.runOnce(),
      intervalMs: MATERIALIZATION_INTERVAL_MS,
      onError: (error) => reportLoopError("materialization", error),
    }),
    startQuotaLoop({
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
      onError: (error) => reportLoopError("lifecycle-boundaries", error),
    }),
    startQuotaLoop({
      runOnce: () => nativeAudit.runOnce(),
      intervalMs: NATIVE_AUDIT_INTERVAL_MS,
      onError: (error) => reportLoopError("native-audit", error),
    }),
  ];
  return Object.freeze({
    stop() {
      for (const loop of loops) loop.stop();
    },
  });
}
