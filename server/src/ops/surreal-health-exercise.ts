import {
  exerciseHealthProbeDisconnect,
  healthProbeSnapshot,
} from "../db/health-probe";
import type {
  ExerciseDisconnectResult,
  RootConnectionSnapshot,
} from "../db/root-connection";

/**
 * /health 探测连接受控 down→up 演练服务（ops 控制面策略层）：
 * - 机制层 RootConnectionManager.exerciseDisconnect 只负责真实断开 +
 *   重连抑制窗口；本层负责滥用防护与审计；
 * - 限频：两次成功演练之间的最小间隔（防 /health 被反复打 down）；
 * - 单次时长上限：holdMs 封顶，窗口内抑制重连、窗口后既有自动重连接管；
 * - 并发保护：进行中的演练调用被幂等搭载，同一时刻至多一次断连动作；
 * - 审计：结构化日志落 journald（本链约束禁 schema 变更，不落库）。
 */
export const SURREAL_HEALTH_EXERCISE_DEFAULT_HOLD_MS = 5_000;
export const SURREAL_HEALTH_EXERCISE_MAX_HOLD_MS = 30_000;
export const SURREAL_HEALTH_EXERCISE_MIN_INTERVAL_MS = 5 * 60_000;

export class SurrealHealthExerciseError extends Error {
  constructor(
    readonly code: "invalid_hold" | "rate_limited" | "unavailable",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SurrealHealthExerciseError";
  }
}

export type SurrealHealthExerciseAudit = {
  event: "surreal_health_exercise";
  outcome: "exercised" | "noop" | "rate_limited" | "attached";
  actorSubject: string;
  holdMs: number;
  noopReason?: string;
  requestedReason?: string;
  resumeAt?: string;
  probeState: string;
};

export type SurrealHealthExerciseOutcome = {
  exercised: boolean;
  /** exercised=false 时的原因（no_connection/already_disconnected/superseded/closing）。 */
  reason?: string;
  /** 请求方被幂等搭载到进行中的演练时为 true。 */
  attached?: boolean;
  holdMs: number;
  /** 重连抑制窗口的结束时刻（ISO）；noop 时为 null。 */
  resumeAt: string | null;
  probe: RootConnectionSnapshot;
};

export type SurrealHealthExerciseStatus = {
  probe: RootConnectionSnapshot;
  exercise: {
    inFlight: boolean;
    lastExercisedAt: string | null;
    minIntervalMs: number;
    defaultHoldMs: number;
    maxHoldMs: number;
  };
};

export type SurrealHealthExercisePort = {
  exercise(input: {
    actorSubject: string;
    holdMs?: number;
    reason?: string;
  }): Promise<SurrealHealthExerciseOutcome>;
  status(): SurrealHealthExerciseStatus;
};

export type SurrealHealthExerciseServiceDeps = {
  /** 演练断连机制；生产默认 health-probe 管理器。 */
  exerciseDisconnect?: (holdMs: number) => Promise<ExerciseDisconnectResult>;
  snapshot?: () => RootConnectionSnapshot;
  now?: () => number;
  minIntervalMs?: number;
  defaultHoldMs?: number;
  maxHoldMs?: number;
  audit?: (entry: SurrealHealthExerciseAudit) => void;
};

export class SurrealHealthExerciseService implements SurrealHealthExercisePort {
  private readonly exerciseDisconnect: (holdMs: number) => Promise<ExerciseDisconnectResult>;
  private readonly snapshot: () => RootConnectionSnapshot;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly defaultHoldMs: number;
  private readonly maxHoldMs: number;
  private readonly audit: (entry: SurrealHealthExerciseAudit) => void;
  private inFlight: Promise<SurrealHealthExerciseOutcome> | null = null;
  private lastExercisedAt: number | null = null;

  constructor(deps: SurrealHealthExerciseServiceDeps = {}) {
    this.exerciseDisconnect =
      deps.exerciseDisconnect ?? exerciseHealthProbeDisconnect;
    this.snapshot = deps.snapshot ?? healthProbeSnapshot;
    this.now = deps.now ?? (() => Date.now());
    this.minIntervalMs =
      deps.minIntervalMs ?? SURREAL_HEALTH_EXERCISE_MIN_INTERVAL_MS;
    this.defaultHoldMs =
      deps.defaultHoldMs ?? SURREAL_HEALTH_EXERCISE_DEFAULT_HOLD_MS;
    this.maxHoldMs = deps.maxHoldMs ?? SURREAL_HEALTH_EXERCISE_MAX_HOLD_MS;
    this.audit =
      deps.audit ??
      ((entry) => console.info("[ops.surreal-health-exercise]", entry));
  }

  status(): SurrealHealthExerciseStatus {
    return {
      probe: this.snapshot(),
      exercise: {
        inFlight: this.inFlight !== null,
        lastExercisedAt:
          this.lastExercisedAt === null
            ? null
            : new Date(this.lastExercisedAt).toISOString(),
        minIntervalMs: this.minIntervalMs,
        defaultHoldMs: this.defaultHoldMs,
        maxHoldMs: this.maxHoldMs,
      },
    };
  }

  async exercise(input: {
    actorSubject: string;
    holdMs?: number;
    reason?: string;
  }): Promise<SurrealHealthExerciseOutcome> {
    const holdMs = input.holdMs ?? this.defaultHoldMs;
    if (
      !Number.isInteger(holdMs)
      || holdMs < 0
      || holdMs > this.maxHoldMs
    ) {
      throw new SurrealHealthExerciseError(
        "invalid_hold",
        `holdMs must be an integer from 0 to ${this.maxHoldMs}`,
      );
    }
    // 并发幂等：进行中的演练调用被搭载，同一断连动作只执行一次。
    if (this.inFlight) {
      this.writeAudit("attached", input, holdMs, {});
      const outcome = await this.inFlight;
      return { ...outcome, attached: true };
    }
    if (
      this.lastExercisedAt !== null
      && this.now() - this.lastExercisedAt < this.minIntervalMs
    ) {
      const retryAfterMs =
        this.minIntervalMs - (this.now() - this.lastExercisedAt);
      this.writeAudit("rate_limited", input, holdMs, {});
      throw new SurrealHealthExerciseError(
        "rate_limited",
        "SurrealDB health exercise is rate limited",
        retryAfterMs,
      );
    }
    this.inFlight = this.run(input.actorSubject, holdMs, input.reason);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(
    actorSubject: string,
    holdMs: number,
    reason?: string,
  ): Promise<SurrealHealthExerciseOutcome> {
    const result = await this.exerciseDisconnect(holdMs);
    const probe = this.snapshot();
    if (result.exercised) {
      this.lastExercisedAt = this.now();
      const resumeAt = new Date(result.resumeAt).toISOString();
      this.writeAudit("exercised", { actorSubject, reason }, holdMs, {
        resumeAt,
        probeState: probe.state,
      });
      return { exercised: true, holdMs, resumeAt, probe };
    }
    this.writeAudit("noop", { actorSubject, reason }, holdMs, {
      noopReason: result.reason,
      probeState: probe.state,
    });
    return {
      exercised: false,
      reason: result.reason,
      holdMs,
      resumeAt: null,
      probe,
    };
  }

  private writeAudit(
    outcome: SurrealHealthExerciseAudit["outcome"],
    input: { actorSubject: string; reason?: string },
    holdMs: number,
    extra: { noopReason?: string; resumeAt?: string; probeState?: string },
  ): void {
    this.audit({
      event: "surreal_health_exercise",
      outcome,
      actorSubject: input.actorSubject,
      holdMs,
      ...(input.reason ? { requestedReason: input.reason } : {}),
      ...(extra.noopReason ? { noopReason: extra.noopReason } : {}),
      ...(extra.resumeAt ? { resumeAt: extra.resumeAt } : {}),
      probeState: extra.probeState ?? this.snapshot().state,
    });
  }
}
