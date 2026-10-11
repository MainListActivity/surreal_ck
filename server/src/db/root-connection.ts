import { Surreal } from "surrealdb";
import { env } from "../env";
import { instrumentSurrealQuery } from "./query-logging";
import { createRootSessionPool } from "./root-session-pool";

/**
 * root 连接状态机（生产 /health 假阴性卡死修复）。
 *
 * 历史缺陷（2026-10-11 生产事件）：checkRootConnection 在 connected=false 时
 * 早退不再实测，恢复完全依赖 connectRootOnce 新建连接成功；一旦新连接持续
 * 失败（握手/auth/连接上限，F4 间歇模式），即使旧连接对象仍存活并服务
 * root session pool 与 quotaWorker，标志也永远卡 down——/health 失去
 * 「当前真实状态」语义。另有无实例身份校验的事件处理器与可重叠的重连尝试，
 * 陈旧事件/迟到失败会翻转已健康的状态，重连循环还会制造连接风暴。
 *
 * 修复语义：
 * - 显式三态（disconnected/connecting/connected），健康探测先**实测现有连接**
 *   （半开探测）：成功即恢复 connected，不换连接、不清池；
 * - 单飞重连：同一时刻至多一个连接尝试，杜绝重连风暴；
 * - 事件处理器按实例身份隔离：被替换的旧实例事件不再影响状态；
 * - 退避含 jitter 且有尝试最小间隔，失败如实报 down，自治恢复后转 ok。
 */
export type RootConnectionState = "disconnected" | "connecting" | "connected";

export type RootConnectionManagerOptions = {
  /** 连接工厂（测试注入假连接；生产为 () => new Surreal()）。 */
  createSurreal?: () => Surreal;
  /** 单次 connect() 的超时（握手挂起时放弃并换尝试）。 */
  connectTimeoutMs?: number;
  /** 两次连接尝试之间的最小间隔（防止 /health 高频轮询变成连接风暴）。 */
  minReconnectIntervalMs?: number;
  /** 自治重连退避序列（秒→ms），末位封顶。 */
  backoffMs?: readonly number[];
  now?: () => number;
  random?: () => number;
};

export type RootConnectionSnapshot = {
  state: RootConnectionState;
  reconnectAttempts: number;
  poolSize: number;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000] as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_MIN_RECONNECT_INTERVAL_MS = 1000;
/** worker 环路报错后的探针节流：真实查询一次根连接。 */
const WORKER_ERROR_PROBE_THROTTLE_MS = 10_000;
/** 退避 jitter 幅度（±20%），避免多实例同步重连。 */
const BACKOFF_JITTER_RATIO = 0.2;

type RootAuthentication = {
  username: string;
  password: string;
};

function rootAuthentication(): RootAuthentication {
  return {
    username: env.SURREAL_ROOT_USER,
    password: env.SURREAL_ROOT_PASS,
  };
}

export function createRootSessionSource(getConnection: () => Surreal = getRootConnection) {
  return {
    async newSession() {
      // forkSession（不是 newSession）：fork 会克隆当前会话的 namespace/database/
      // authentication state，派生出的 session 仍以 root 身份登录；newSession 派生的是
      // 一条**未认证**的全新会话，匿名身份受 PERMISSIONS 限制看不到任何数据
      // （SELECT 返回 [[]]），导致 listWorkspaces 等永远查不到行。
      const session = await getConnection().forkSession();
      return instrumentSurrealQuery(session, { source: "server:root-session" });
    },
  };
}

/** 退避序列第 attempt 档的延迟（含 ±20% jitter，末位封顶）。 */
export function nextBackoffDelayMs(
  attempt: number,
  backoffMs: readonly number[] = DEFAULT_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const base = backoffMs[Math.min(Math.max(attempt, 0), backoffMs.length - 1)]!;
  const jitter = base * BACKOFF_JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export class RootConnectionManager {
  private readonly createSurreal: () => Surreal;
  private readonly connectTimeoutMs: number;
  private readonly minReconnectIntervalMs: number;
  private readonly backoffMs: readonly number[];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pool = createRootSessionPool(
    createRootSessionSource(() => this.getConnection()),
  );

  private connection: Surreal | null = null;
  private state: RootConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 单飞：同一时刻至多一个进行中的连接尝试。 */
  private inFlight: Promise<boolean> | null = null;
  private lastAttemptAt = 0;
  private lastWorkerErrorProbeAt = 0;
  private closing = false;

  constructor(options: RootConnectionManagerOptions = {}) {
    this.createSurreal = options.createSurreal ?? (() => new Surreal());
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.minReconnectIntervalMs =
      options.minReconnectIntervalMs ?? DEFAULT_MIN_RECONNECT_INTERVAL_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  snapshot(): RootConnectionSnapshot {
    return {
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      poolSize: this.pool.size(),
    };
  }

  async init(): Promise<void> {
    this.closing = false;
    await this.ensureConnected();
  }

  getConnection(): Surreal {
    if (!this.connection) {
      throw new Error("SurrealDB root connection is not initialized");
    }
    return this.connection;
  }

  /**
   * 长生命周期消费者的稳定根连接引用：每次调用都转发到**当前**连接实例。
   *
   * startNativeQuotaRuntime 等启动期捕获连接对象的消费方，若直接持有实例，
   * 断线重连（connection 被替换、旧实例 close）后它们会永远打到已关闭的
   * 旧连接上——HTTP /health 走实时查找仍显示正常，控制面 worker 全部静默失活。
   * 稳定引用按调用时刻解析，重连后下一 tick 即恢复。
   */
  getStableConnection(): Surreal {
    const resolve = () => this.getConnection() as unknown as Record<PropertyKey, unknown>;
    return new Proxy({} as Surreal, {
      get(_target, prop) {
        const current = resolve();
        const value = current[prop];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const latest = resolve();
          const fn = latest[prop] as (...a: unknown[]) => unknown;
          return fn.apply(latest, args);
        };
      },
    });
  }

  async getDatabaseSession(database: string, namespace = env.SURREAL_NS) {
    return this.pool.get(database, namespace);
  }

  /**
   * 健康探测（/health 与 worker 报错兜底共用）：
   * 1. 有连接实例就先**实测**它（半开探测：SDK 不发事件的静默断链只有真实
   *    往返才会暴露）；探测成功即视为当前真实状态为 up——瞬断/旧连接仍存活
   *    时直接恢复，不重建连接；
   * 2. 探测失败或无实例时，单飞发起一次连接尝试（受最小间隔约束），按结果
   *    如实返回。任何路径都不会「常 ok」。
   */
  async checkConnection(timeoutMs = 5000): Promise<boolean> {
    if (this.closing) {
      return false;
    }

    const current = this.connection;
    if (current) {
      const alive = await this.probe(current, timeoutMs);
      if (alive) {
        if (this.connection !== current) {
          // 探测期间连接已被替换（另一尝试成功）：取最新状态。
          return this.ensureConnected();
        }
        if (this.state !== "connected") {
          this.state = "connected";
          this.reconnectAttempts = 0;
          console.info("[surrealdb] root connection recovered via probe", {
            url: env.SURREAL_URL,
          });
        }
        return true;
      }
      this.markDisconnected("health probe failed");
    }

    return this.ensureConnected();
  }

  /**
   * worker 环路报错后的节流探针：真实查询一次根连接。
   * 连接实际健康时仅复位状态（不重建）；确有问题时走重连。
   */
  probeAfterWorkerError(): void {
    const now = this.now();
    if (now - this.lastWorkerErrorProbeAt < WORKER_ERROR_PROBE_THROTTLE_MS) return;
    this.lastWorkerErrorProbeAt = now;
    void this.checkConnection(3_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const db = this.connection;
    this.connection = null;
    this.state = "disconnected";

    await this.pool.closeAll();

    if (db) {
      await db.close();
    }
  }

  /** 对指定连接实例做一次真实查询（有界）。只读探测，不改状态。 */
  private async probe(connection: Surreal, timeoutMs: number): Promise<boolean> {
    try {
      await Promise.race([
        connection.query("RETURN 1"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SurrealDB health timeout")), timeoutMs)
        ),
      ]);
      return true;
    } catch (error) {
      console.warn("[surrealdb] root health probe failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private markDisconnected(reason: string): void {
    if (this.state !== "disconnected") {
      this.state = "disconnected";
      console.warn("[surrealdb] root connection marked disconnected", { reason });
    }
    // 无论此前是否已 disconnected，都要保证有自治重试计划：
    // 被最小间隔 gate 挡住的探测失败不能变成「谁都不再重试」。
    this.scheduleReconnect();
  }

  /** 单飞入口：已连接直接 true；有进行中尝试则搭载其 promise；否则按最小间隔发起新尝试。 */
  private ensureConnected(): Promise<boolean> {
    if (this.closing) {
      return Promise.resolve(false);
    }
    if (this.state === "connected" && this.connection) {
      return Promise.resolve(true);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const now = this.now();
    if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < this.minReconnectIntervalMs) {
      // 刚刚尝试失败且 DB 仍不可达：如实 down，不加速重试；
      // 但要保证 gate 窗口结束后有人再试（自治恢复不依赖轮询节奏）。
      this.scheduleReconnect(this.minReconnectIntervalMs - (now - this.lastAttemptAt));
      return Promise.resolve(false);
    }
    this.inFlight = this.connectOnce(this.connectTimeoutMs);
    return this.inFlight;
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.closing || this.reconnectTimer) {
      return;
    }

    const delay =
      delayMs ?? nextBackoffDelayMs(this.reconnectAttempts, this.backoffMs, this.random);
    if (delayMs === undefined) {
      this.reconnectAttempts += 1;
    }
    console.warn("[surrealdb] root reconnect scheduled", {
      delayMs: delay,
      attempt: this.reconnectAttempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => undefined);
    }, delay);
  }

  private async connectOnce(timeoutMs: number): Promise<boolean> {
    this.lastAttemptAt = this.now();
    this.state = "connecting";
    const db = this.createSurreal();

    // 事件处理器按实例身份隔离：只有「当前连接实例」的事件才允许改状态。
    // 被替换的旧实例（已 close 或握手迟到失败）不能再把健康的连接标成 down。
    db.subscribe("disconnected", () => {
      if (this.connection !== db) return;
      this.markDisconnected("connection disconnected");
    });
    db.subscribe("error", (error: Error) => {
      if (this.connection !== db) return;
      this.markDisconnected(
        `connection error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    try {
      await Promise.race([
        (async () => {
          await db.connect(env.SURREAL_URL, {
            reconnect: false,
            authentication: rootAuthentication,
            namespace: env.SURREAL_NS,
            database: "_system",
          });
          await db.use({ namespace: env.SURREAL_NS, database: "_system" });
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SurrealDB root connection timeout")), timeoutMs)
        ),
      ]);

      const previousConnection = this.connection;
      // 先切换引用再关闭旧连接：旧实例 close() 会发布 disconnected，
      // 此时身份已不等于当前连接，处理器会忽略（陈旧事件隔离）。
      this.connection = instrumentSurrealQuery(db, {
        source: "server:root",
        initialScope: { namespace: env.SURREAL_NS, database: "_system" },
      });
      this.state = "connected";
      this.reconnectAttempts = 0;
      console.info("[surrealdb] root connected", { url: env.SURREAL_URL, namespace: env.SURREAL_NS });

      await this.pool.closeAll();
      if (previousConnection && previousConnection !== db) {
        try {
          await previousConnection.close();
        } catch {
          // Ignore cleanup errors for a stale connection after reconnect.
        }
      }
      return true;
    } catch (error) {
      try {
        await db.close();
      } catch {
        // Ignore close errors while handling a failed connection attempt.
      }

      console.warn("[surrealdb] root connection failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      // 尝试失败即断开；除非探测自愈在尝试期间已把旧连接修回 connected
      // （此时旧连接经过真实查询验证，保持现状更 truthful）。
      if (this.state === "connecting") {
        this.state = "disconnected";
      }
      return false;
    } finally {
      this.inFlight = null;
      // 尝试结束（成功或失败）后，未连接且未关闭时必须保证有重连计划。
      // 探测自愈把状态修回 connected 时无需再排。
      if (this.state !== "connected" && !this.closing) {
        this.scheduleReconnect();
      }
    }
  }
}

const manager = new RootConnectionManager();

/** 管理器工厂：生产用单例，测试/未来 DI 用独立实例。 */
export function createRootConnectionManager(
  options: RootConnectionManagerOptions = {},
): RootConnectionManager {
  return new RootConnectionManager(options);
}

export function initRootConnection(): Promise<void> {
  return manager.init();
}

export function getRootConnection(): Surreal {
  return manager.getConnection();
}

export function getStableRootConnection(): Surreal {
  return manager.getStableConnection();
}

export function getRootDatabaseSession(database: string, namespace = env.SURREAL_NS) {
  return manager.getDatabaseSession(database, namespace);
}

export function checkRootConnection(timeoutMs = 5000): Promise<boolean> {
  return manager.checkConnection(timeoutMs);
}

export function probeRootConnectionAfterWorkerError(): void {
  manager.probeAfterWorkerError();
}

export function closeRootConnection(): Promise<void> {
  return manager.close();
}
