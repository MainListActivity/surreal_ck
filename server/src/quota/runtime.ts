import { getRootConnection } from "../db/root-connection";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { SurrealQuotaControlPlaneStore } from "./control-plane-store";
import { SurrealEntitlementRefreshService } from "./entitlement-refresh";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";
import { SurrealLifecycleBoundarySweepHandler } from "./lifecycle-sweep";
import { QuotaReconciler } from "./reconciler";
import { QuotaLifecycleCoordinator } from "./subscription-lifecycle";
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
  const refresher = new SurrealEntitlementRefreshService(db);
  const reconciler = new QuotaReconciler(
    controlStore,
    new SurrealNativeQuotaClient(db),
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
  const lifecycle = new QuotaLifecycleCoordinator(
    lifecycleStore,
    refresher,
    `${workerId}:lifecycle`,
    { wake: wakeMaterialization },
  );
  const boundarySweep = new ControlPlaneSweep(
    controlStore,
    new SurrealLifecycleBoundarySweepHandler(db, refresher),
    `${workerId}:boundary`,
  );
  const nativeClient = new SurrealNativeQuotaClient(db);
  const nativeAudit = new NativeAuditSweep(
    controlStore,
    new SurrealNativeAuditSweepHandler(
      db,
      new SurrealQuotaAuthorityReader({ db }),
      nativeClient,
      new QuotaObservationService(
        new SurrealQuotaObservationStore({ db }),
      ),
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
