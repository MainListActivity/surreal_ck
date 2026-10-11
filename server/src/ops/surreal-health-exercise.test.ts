import { describe, expect, test } from "bun:test";
import type { ExerciseDisconnectResult } from "../db/root-connection";
import {
  SurrealHealthExerciseError,
  SurrealHealthExerciseService,
  type SurrealHealthExerciseAudit,
} from "./surreal-health-exercise";

const connectedSnapshot = () => ({
  state: "connected" as const,
  reconnectAttempts: 0,
  poolSize: 0,
});

function createService(overrides: {
  exerciseDisconnect?: (holdMs: number) => Promise<ExerciseDisconnectResult>;
  now?: () => number;
  minIntervalMs?: number;
  maxHoldMs?: number;
  audits?: SurrealHealthExerciseAudit[];
}) {
  const audits = overrides.audits ?? [];
  let clock = 1_000_000;
  const service = new SurrealHealthExerciseService({
    exerciseDisconnect:
      overrides.exerciseDisconnect
      ?? (async (holdMs) => ({
          exercised: true as const,
          holdMs,
          resumeAt: clock + holdMs,
        })),
    snapshot: connectedSnapshot,
    now: overrides.now ?? (() => clock),
    minIntervalMs: overrides.minIntervalMs ?? 300_000,
    maxHoldMs: overrides.maxHoldMs ?? 30_000,
    audit: (entry) => audits.push(entry),
  });
  return {
    service,
    audits,
    advance(ms: number) {
      clock += ms;
    },
    setClock(value: number) {
      clock = value;
    },
    now() {
      return clock;
    },
  };
}

describe("SurrealHealthExerciseService", () => {
  test("正常演练：返回 exercised + resumeAt，写 exercised 审计，打上时间戳", async () => {
    const { service, audits, now } = createService({});

    const outcome = await service.exercise({ actorSubject: "operator:qa" });

    expect(outcome.exercised).toBe(true);
    expect(outcome.holdMs).toBe(5_000);
    expect(outcome.resumeAt).toBe(new Date(now() + 5_000).toISOString());
    expect(outcome.probe.state).toBe("connected");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: "surreal_health_exercise",
      outcome: "exercised",
      actorSubject: "operator:qa",
      holdMs: 5_000,
    });
    expect(service.status().exercise.lastExercisedAt).not.toBeNull();
  });

  test("holdMs 校验：非整数/负数/超上限均 invalid_hold，不触发断连", async () => {
    let calls = 0;
    const { service } = createService({
      exerciseDisconnect: async () => {
        calls += 1;
        return { exercised: true, holdMs: 0, resumeAt: 0 };
      },
    });

    for (const bad of [-1, 30_001, 1.5, Number.NaN]) {
      try {
        await service.exercise({ actorSubject: "a", holdMs: bad });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SurrealHealthExerciseError);
        expect((error as SurrealHealthExerciseError).code).toBe("invalid_hold");
      }
    }
    expect(calls).toBe(0);
  });

  test("限频：间隔内第二次成功演练 429 并带 retryAfterMs；间隔后放行", async () => {
    const { service, advance, audits } = createService({ minIntervalMs: 60_000 });

    await service.exercise({ actorSubject: "a", holdMs: 100 });
    advance(10_000);
    try {
      await service.exercise({ actorSubject: "a", holdMs: 100 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SurrealHealthExerciseError);
      const err = error as SurrealHealthExerciseError;
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfterMs).toBe(50_000);
    }
    expect(audits.map((a) => a.outcome)).toEqual(["exercised", "rate_limited"]);

    advance(50_001);
    const again = await service.exercise({ actorSubject: "a", holdMs: 100 });
    expect(again.exercised).toBe(true);
  });

  test("并发幂等：进行中的演练被搭载，断连只执行一次", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, audits } = createService({
      exerciseDisconnect: async (holdMs) => {
        calls += 1;
        await gate;
        return { exercised: true, holdMs, resumeAt: 1_000_000 + holdMs };
      },
    });

    const first = service.exercise({ actorSubject: "a", holdMs: 500 });
    const second = service.exercise({ actorSubject: "b", holdMs: 900 });
    release!();
    const [one, two] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(one.exercised).toBe(true);
    expect(two.exercised).toBe(true);
    // 搭载者拿到同一演练窗口（first 的 holdMs），并标记 attached。
    expect(two.holdMs).toBe(one.holdMs);
    expect(two.attached).toBe(true);
    expect(audits.map((a) => a.outcome).sort()).toEqual(["attached", "exercised"]);
  });

  test("幂等 no-op：连接已断开时 exercised=false 且不消耗限频预算", async () => {
    const { service, audits } = createService({
      exerciseDisconnect: async () => ({
        exercised: false as const,
        reason: "already_disconnected" as const,
      }),
    });

    const outcome = await service.exercise({ actorSubject: "a" });

    expect(outcome.exercised).toBe(false);
    expect(outcome.reason).toBe("already_disconnected");
    expect(outcome.resumeAt).toBeNull();
    expect(audits[0]).toMatchObject({ outcome: "noop", noopReason: "already_disconnected" });
    // no-op 不占用限频：下一次调用仍按限频规则判定（首窗口未建立）。
    expect(service.status().exercise.lastExercisedAt).toBeNull();
  });

  test("status：暴露探测快照与演练节流参数", async () => {
    const { service } = createService({ minIntervalMs: 60_000, maxHoldMs: 15_000 });

    const status = service.status();

    expect(status.probe).toMatchObject({ state: "connected" });
    expect(status.exercise).toMatchObject({
      inFlight: false,
      lastExercisedAt: null,
      minIntervalMs: 60_000,
      maxHoldMs: 15_000,
    });
  });
});
