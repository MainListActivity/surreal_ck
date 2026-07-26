import type {
  ControlPlaneObject,
  QuotaSweepName,
  SurrealInteger,
} from "@surreal-ck/shared/native-quota";
import { DateTime } from "surrealdb";
import type { MaterializationLease } from "./reconciler";
import { QuotaReconciler } from "./reconciler";

const DEFAULT_SWEEP_LEASE_MS = 60_000;
const DEFAULT_SWEEP_BACKOFF_MS = 5_000;
const DEFAULT_SWEEP_MAX_BACKOFF_MS = 15 * 60_000;

export interface MaterializationQueue {
  claimNextMaterialization(input: Readonly<{
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }>): Promise<MaterializationLease | undefined>;
}

export type MaterializationWorkerResult =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "processed";
      reconcile: Awaited<ReturnType<QuotaReconciler["reconcile"]>>;
    }>;

export class MaterializationWorker {
  constructor(
    private readonly queue: MaterializationQueue,
    private readonly reconciler: QuotaReconciler,
    private readonly workerId: string,
    private readonly options: Readonly<{
      leaseDurationMs?: number;
      clock?: Readonly<{ now(): DateTime }>;
    }> = {},
  ) {}

  async runOnce(): Promise<MaterializationWorkerResult> {
    const lease = await this.queue.claimNextMaterialization({
      workerId: this.workerId,
      now: this.options.clock?.now() ?? DateTime.now(),
      leaseDurationMs:
        this.options.leaseDurationMs ?? DEFAULT_SWEEP_LEASE_MS,
    });
    if (!lease) return Object.freeze({ kind: "idle" });
    return Object.freeze({
      kind: "processed",
      reconcile: await this.reconciler.reconcile(lease),
    });
  }
}

export type SweepLease = Readonly<{
  name: QuotaSweepName;
  workerId: string;
  fencingToken: SurrealInteger;
  cursor?: string;
  epoch: SurrealInteger;
  attemptNumber: SurrealInteger;
  startedAt: DateTime;
  leaseExpiresAt: DateTime;
}>;

export interface PersistentSweepStore {
  claimSweep(input: Readonly<{
    name: QuotaSweepName;
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }>): Promise<SweepLease | undefined>;
  checkpointSweep(
    lease: SweepLease,
    checkpoint: Readonly<{
      cursor?: string;
      completed: boolean;
      processed: number;
      failed: number;
      completedAt: DateTime;
    }>,
  ): Promise<boolean>;
  failSweep(
    lease: SweepLease,
    failure: Readonly<{
      errorCode: string;
      errorRetryable: boolean;
      errorDetails: ControlPlaneObject;
      nextAttemptAt: DateTime;
      failedAt: DateTime;
    }>,
  ): Promise<boolean>;
}

export type SweepPageResult = Readonly<{
  nextCursor?: string;
  completed: boolean;
  processed: number;
  failed: number;
}>;

export interface SweepPageHandler {
  processPage(input: Readonly<{
    cursor?: string;
    limit: number;
    fencingToken: SurrealInteger;
  }>): Promise<SweepPageResult>;
}

export type PersistentSweepResult =
  | Readonly<{ kind: "idle"; name: QuotaSweepName }>
  | Readonly<{
      kind: "checkpointed";
      name: QuotaSweepName;
      completed: boolean;
      processed: number;
      failed: number;
    }>
  | Readonly<{ kind: "retry_scheduled"; name: QuotaSweepName; errorCode: string }>
  | Readonly<{ kind: "lease_lost"; name: QuotaSweepName }>;

export type PersistentSweepOptions = Readonly<{
  leaseDurationMs?: number;
  pageLimit?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  clock?: Readonly<{ now(): DateTime }>;
  random?: () => number;
}>;

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(Math.round(milliseconds)) * 1_000_000n,
  );
}

function sweepError(error: unknown): Readonly<{
  code: string;
  details: ControlPlaneObject;
}> {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (
      typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    )
    ? error.code
    : "quota_sweep_failed";
  return {
    code,
    details: Object.freeze({ error_name: name }),
  };
}

class PersistentSweepRunner {
  private readonly leaseDurationMs: number;
  private readonly pageLimit: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: Readonly<{ now(): DateTime }>;
  private readonly random: () => number;

  constructor(
    private readonly name: QuotaSweepName,
    private readonly store: PersistentSweepStore,
    private readonly handler: SweepPageHandler,
    private readonly workerId: string,
    options: PersistentSweepOptions = {},
  ) {
    this.leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_SWEEP_LEASE_MS;
    this.pageLimit = options.pageLimit ?? 100;
    this.baseBackoffMs =
      options.baseBackoffMs ?? DEFAULT_SWEEP_BACKOFF_MS;
    this.maxBackoffMs =
      options.maxBackoffMs ?? DEFAULT_SWEEP_MAX_BACKOFF_MS;
    this.clock = options.clock ?? { now: () => DateTime.now() };
    this.random = options.random ?? Math.random;
  }

  async runOnce(): Promise<PersistentSweepResult> {
    const lease = await this.store.claimSweep({
      name: this.name,
      workerId: this.workerId,
      now: this.clock.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!lease) return Object.freeze({ kind: "idle", name: this.name });

    try {
      const page = await this.handler.processPage({
        cursor: lease.cursor,
        limit: this.pageLimit,
        fencingToken: lease.fencingToken,
      });
      const accepted = await this.store.checkpointSweep(lease, {
        cursor: page.nextCursor,
        completed: page.completed,
        processed: page.processed,
        failed: page.failed,
        completedAt: this.clock.now(),
      });
      return accepted
        ? Object.freeze({
            kind: "checkpointed",
            name: this.name,
            completed: page.completed,
            processed: page.processed,
            failed: page.failed,
          })
        : Object.freeze({ kind: "lease_lost", name: this.name });
    } catch (error) {
      const classified = sweepError(error);
      const attempt = Math.max(1, Number(lease.attemptNumber));
      const backoff = Math.min(
        this.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
        this.maxBackoffMs,
      );
      const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5;
      const failedAt = this.clock.now();
      const accepted = await this.store.failSweep(lease, {
        errorCode: classified.code,
        errorRetryable: true,
        errorDetails: classified.details,
        nextAttemptAt: addMilliseconds(failedAt, backoff * jitter),
        failedAt,
      });
      return accepted
        ? Object.freeze({
            kind: "retry_scheduled",
            name: this.name,
            errorCode: classified.code,
          })
        : Object.freeze({ kind: "lease_lost", name: this.name });
    }
  }
}

export class ControlPlaneSweep {
  private readonly runner: PersistentSweepRunner;

  constructor(
    store: PersistentSweepStore,
    handler: SweepPageHandler,
    workerId: string,
    options?: PersistentSweepOptions,
  ) {
    this.runner = new PersistentSweepRunner(
      "control_plane_sweep",
      store,
      handler,
      workerId,
      options,
    );
  }

  runOnce(): Promise<PersistentSweepResult> {
    return this.runner.runOnce();
  }
}

export class NativeAuditSweep {
  private readonly runner: PersistentSweepRunner;

  constructor(
    store: PersistentSweepStore,
    handler: SweepPageHandler,
    workerId: string,
    options?: PersistentSweepOptions,
  ) {
    this.runner = new PersistentSweepRunner(
      "native_audit_sweep",
      store,
      handler,
      workerId,
      options,
    );
  }

  runOnce(): Promise<PersistentSweepResult> {
    return this.runner.runOnce();
  }
}

export class ProviderReconciliation {
  private readonly runner: PersistentSweepRunner;

  constructor(
    store: PersistentSweepStore,
    handler: SweepPageHandler,
    workerId: string,
    options?: PersistentSweepOptions,
  ) {
    this.runner = new PersistentSweepRunner(
      "provider_reconciliation",
      store,
      handler,
      workerId,
      options,
    );
  }

  runOnce(): Promise<PersistentSweepResult> {
    return this.runner.runOnce();
  }
}

export type QuotaLoopHandle = Readonly<{ stop(): void }>;

export function startQuotaLoop(input: Readonly<{
  runOnce(): Promise<unknown>;
  intervalMs: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}>): QuotaLoopHandle {
  const tick = () => {
    void input.runOnce().catch((error) => input.onError?.(error));
  };
  tick();
  const setIntervalFn =
    input.setInterval ?? ((handler, milliseconds) => setInterval(handler, milliseconds));
  const clearIntervalFn =
    input.clearInterval
    ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  const timer = setIntervalFn(tick, input.intervalMs);
  return Object.freeze({ stop: () => clearIntervalFn(timer) });
}
