import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneObject,
  QuotaSweepName,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import type {
  MaterializationLease,
  QuotaReconcileResult,
} from "./reconciler";
import { QuotaReconciler } from "./reconciler";
import {
  ControlPlaneSweep,
  MaterializationWorker,
  NativeAuditSweep,
  ProviderReconciliation,
  startQuotaLoop,
  type PersistentSweepStore,
  type SweepLease,
} from "./sweeps";

type CursorState = {
  cursor?: string;
  epoch: number;
  leaseOwner?: string;
  leaseExpiresAt?: DateTime;
  fencingToken: number;
  attemptCount: number;
  nextAttemptAt?: DateTime;
  lastErrorCode?: string;
};

const start = new DateTime("2026-08-02T00:00:00.000Z");

function at(milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    start.nanoseconds + BigInt(milliseconds) * 1_000_000n,
  );
}

class MemorySweepStore implements PersistentSweepStore {
  readonly states = new Map<QuotaSweepName, CursorState>();

  state(name: QuotaSweepName): CursorState {
    let current = this.states.get(name);
    if (!current) {
      current = {
        epoch: 0,
        fencingToken: 0,
        attemptCount: 0,
      };
      this.states.set(name, current);
    }
    return current;
  }

  async claimSweep(input: {
    name: QuotaSweepName;
    workerId: string;
    now: DateTime;
    leaseDurationMs: number;
  }): Promise<SweepLease | undefined> {
    const state = this.state(input.name);
    if (
      state.nextAttemptAt
      && input.now.nanoseconds < state.nextAttemptAt.nanoseconds
    ) {
      return undefined;
    }
    if (
      state.leaseOwner
      && state.leaseExpiresAt
      && input.now.nanoseconds < state.leaseExpiresAt.nanoseconds
    ) {
      return undefined;
    }
    state.fencingToken += 1;
    state.attemptCount += 1;
    state.leaseOwner = input.workerId;
    state.leaseExpiresAt = at(
      Number((input.now.nanoseconds - start.nanoseconds) / 1_000_000n)
        + input.leaseDurationMs,
    );
    return {
      name: input.name,
      workerId: input.workerId,
      fencingToken: state.fencingToken,
      cursor: state.cursor,
      epoch: state.epoch,
      attemptNumber: state.attemptCount,
      startedAt: input.now,
      leaseExpiresAt: state.leaseExpiresAt,
    };
  }

  async checkpointSweep(
    lease: SweepLease,
    checkpoint: {
      cursor?: string;
      completed: boolean;
      processed: number;
      failed: number;
      completedAt: DateTime;
    },
  ): Promise<boolean> {
    const state = this.state(lease.name);
    if (
      state.fencingToken !== Number(lease.fencingToken)
      || state.leaseOwner !== lease.workerId
    ) {
      return false;
    }
    state.cursor = checkpoint.completed ? undefined : checkpoint.cursor;
    if (checkpoint.completed) state.epoch += 1;
    state.leaseOwner = undefined;
    state.leaseExpiresAt = undefined;
    state.attemptCount = 0;
    state.nextAttemptAt = undefined;
    state.lastErrorCode = undefined;
    return true;
  }

  async failSweep(
    lease: SweepLease,
    failure: {
      errorCode: string;
      errorRetryable: boolean;
      errorDetails: ControlPlaneObject;
      nextAttemptAt: DateTime;
      failedAt: DateTime;
    },
  ): Promise<boolean> {
    const state = this.state(lease.name);
    if (
      state.fencingToken !== Number(lease.fencingToken)
      || state.leaseOwner !== lease.workerId
    ) {
      return false;
    }
    state.leaseOwner = undefined;
    state.leaseExpiresAt = undefined;
    state.nextAttemptAt = failure.nextAttemptAt;
    state.lastErrorCode = failure.errorCode;
    return true;
  }
}

describe("persistent quota sweeps", () => {
  test("two Bun workers cannot concurrently own one sweep lease", async () => {
    const store = new MemorySweepStore();
    const first = await store.claimSweep({
      name: "control_plane_sweep",
      workerId: "bun-a",
      now: start,
      leaseDurationMs: 1_000,
    });
    const second = await store.claimSweep({
      name: "control_plane_sweep",
      workerId: "bun-b",
      now: start,
      leaseDurationMs: 1_000,
    });

    expect(first?.fencingToken).toBe(1);
    expect(second).toBeUndefined();
  });

  test("expired lease is fenced and only the takeover can checkpoint", async () => {
    const store = new MemorySweepStore();
    const stale = await store.claimSweep({
      name: "native_audit_sweep",
      workerId: "bun-a",
      now: start,
      leaseDurationMs: 1_000,
    });
    const takeover = await store.claimSweep({
      name: "native_audit_sweep",
      workerId: "bun-b",
      now: at(1_001),
      leaseDurationMs: 1_000,
    });
    if (!stale || !takeover) throw new Error("expected both leases");

    await expect(store.checkpointSweep(stale, {
      completed: true,
      processed: 1,
      failed: 0,
      completedAt: at(1_002),
    })).resolves.toBeFalse();
    await expect(store.checkpointSweep(takeover, {
      completed: true,
      processed: 1,
      failed: 0,
      completedAt: at(1_002),
    })).resolves.toBeTrue();
    expect(takeover.fencingToken).toBe(2);
  });

  test("crash/restart resumes the persisted cursor after lease expiry", async () => {
    const store = new MemorySweepStore();
    store.state("provider_reconciliation").cursor = "provider:page-7";
    await store.claimSweep({
      name: "provider_reconciliation",
      workerId: "crashed",
      now: start,
      leaseDurationMs: 1_000,
    });

    let receivedCursor: string | undefined;
    const restarted = new ProviderReconciliation(
      store,
      {
        async processPage(input) {
          receivedCursor = input.cursor;
          return {
            nextCursor: "provider:page-8",
            completed: false,
            processed: 20,
            failed: 1,
          };
        },
      },
      "restarted",
      { clock: { now: () => at(1_001) } },
    );

    await expect(restarted.runOnce()).resolves.toMatchObject({
      kind: "checkpointed",
      processed: 20,
      failed: 1,
    });
    expect(receivedCursor).toBe("provider:page-7");
    expect(store.state("provider_reconciliation").cursor).toBe(
      "provider:page-8",
    );
  });

  test("failure persists exponential backoff and a restart respects it", async () => {
    const store = new MemorySweepStore();
    let now = start;
    const sweep = new ControlPlaneSweep(
      store,
      {
        async processPage() {
          throw Object.assign(new Error("temporary"), {
            code: "provider_unavailable",
          });
        },
      },
      "bun-a",
      {
        clock: { now: () => now },
        random: () => 0.5,
        baseBackoffMs: 5_000,
      },
    );

    await expect(sweep.runOnce()).resolves.toMatchObject({
      kind: "retry_scheduled",
      errorCode: "provider_unavailable",
    });
    now = at(4_999);
    await expect(sweep.runOnce()).resolves.toMatchObject({ kind: "idle" });
    now = at(5_000);
    await expect(sweep.runOnce()).resolves.toMatchObject({
      kind: "retry_scheduled",
    });
    expect(store.state("control_plane_sweep").attemptCount).toBe(2);
  });

  test("native audit and provider reconciliation keep independent cursors", async () => {
    const store = new MemorySweepStore();
    const handler = {
      async processPage() {
        return { completed: true, processed: 2, failed: 0 };
      },
    };
    const audit = new NativeAuditSweep(store, handler, "bun-a", {
      clock: { now: () => start },
    });
    const provider = new ProviderReconciliation(store, handler, "bun-a", {
      clock: { now: () => start },
    });

    await audit.runOnce();
    await provider.runOnce();

    expect(store.state("native_audit_sweep").epoch).toBe(1);
    expect(store.state("provider_reconciliation").epoch).toBe(1);
  });
});

describe("MaterializationWorker and loop scheduling", () => {
  test("worker claims one persisted operation and delegates to reconciler", async () => {
    const claimed = {
      operation: new StringRecordId("quota_materialization_operation:one"),
    } as MaterializationLease;
    const expected: QuotaReconcileResult = {
      kind: "succeeded",
      operation: claimed.operation,
      ddlExecuted: false,
      rebuilt: false,
    };
    const worker = new MaterializationWorker(
      {
        async claimNextMaterialization() {
          return claimed;
        },
      },
      {
        async reconcile() {
          return expected;
        },
      } as QuotaReconciler,
      "bun-a",
      { clock: { now: () => start } },
    );

    await expect(worker.runOnce()).resolves.toEqual({
      kind: "processed",
      reconcile: expected,
    });
  });

  test("loop runs immediately, repeats, and can be stopped", () => {
    let runs = 0;
    let tick: (() => void) | undefined;
    let cleared = false;
    const handle = startQuotaLoop({
      async runOnce() {
        runs += 1;
      },
      intervalMs: 1_000,
      setInterval(handler) {
        tick = handler;
        return "timer";
      },
      clearInterval(handle) {
        cleared = handle === "timer";
      },
    });

    expect(runs).toBe(1);
    tick?.();
    expect(runs).toBe(2);
    handle.stop();
    expect(cleared).toBeTrue();
  });
});
