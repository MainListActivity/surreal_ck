import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  createRootConnectionManager,
  createRootSessionSource,
  nextBackoffDelayMs,
} from "./root-connection";

class FakeRootSession {
  signinCalls = 0;

  async query(): Promise<unknown[]> {
    return [];
  }

  async use(): Promise<void> {}

  async closeSession(): Promise<void> {}

  async signin(): Promise<never> {
    this.signinCalls += 1;
    throw new Error("root child sessions must rely on the connection authentication provider");
  }
}

describe("root connection session source", () => {
  test("does not call signin on child sessions so SDK auth provider can renew root auth", async () => {
    const session = new FakeRootSession();
    // 子 session 必须用 forkSession 派生（继承 root 认证态），不能用 newSession
    // （未认证、受 PERMISSIONS 限制看不到数据）。
    const session_factory = {
      forkCalls: 0,
      newSessionCalls: 0,
      async forkSession() {
        this.forkCalls += 1;
        return session;
      },
      async newSession() {
        this.newSessionCalls += 1;
        throw new Error("root child sessions must be derived via forkSession to inherit root auth");
      },
    };
    const source = createRootSessionSource(() => session_factory as never);

    const created = await source.newSession();

    expect(created).toBe(session);
    expect(session.signinCalls).toBe(0);
    expect(session_factory.forkCalls).toBe(1);
    expect(session_factory.newSessionCalls).toBe(0);
  });
});

type FakeMode = "ok" | "fail" | "hang";

/**
 * 可控假连接：复现生产故障机制而不依赖真实网络。
 * - mode：connect() 行为（ok/fail/hang）
 * - probeMode：query()（健康探测）行为
 */
class FakeSurreal {
  static created: FakeSurreal[] = [];
  /** 新实例创建时继承的默认模式（测试脚本切换）。 */
  static defaultMode: FakeMode = "ok";
  static defaultProbeMode: FakeMode = "ok";

  mode: FakeMode;
  probeMode: FakeMode;
  closed = false;
  connectCalls = 0;
  private listeners = new Map<string, Set<(arg?: unknown) => void>>();

  constructor() {
    this.mode = FakeSurreal.defaultMode;
    this.probeMode = FakeSurreal.defaultProbeMode;
    FakeSurreal.created.push(this);
  }

  subscribe(event: string, listener: (arg?: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(arg);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.mode === "fail") throw new Error("fake connect failed");
    if (this.mode === "hang") return new Promise<void>(() => {});
  }

  async use(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 真实 SDK 在引擎终止时发布 disconnected。
    this.emit("disconnected");
  }

  async query(): Promise<unknown[]> {
    if (this.probeMode === "fail") throw new Error("fake probe failed");
    if (this.probeMode === "hang") return new Promise<unknown[]>(() => {});
    return [];
  }

  get isConnected(): boolean {
    return !this.closed;
  }
}

function resetFakes(): void {
  FakeSurreal.created = [];
  FakeSurreal.defaultMode = "ok";
  FakeSurreal.defaultProbeMode = "ok";
}

/** 测试用快速退避；重连最小间隔置 0，gate 由专门用例覆盖。 */
const TEST_BACKOFF_MS = [40, 80, 160] as const;

function createManager(minReconnectIntervalMs = 0) {
  return createRootConnectionManager({
    createSurreal: () => new FakeSurreal() as unknown as Surreal,
    connectTimeoutMs: 120,
    minReconnectIntervalMs,
    backoffMs: TEST_BACKOFF_MS,
    random: () => 1,
  });
}

describe("root connection manager health state machine", () => {
  test("半开/瞬断后旧连接仍存活：探测实测恢复 ok，不卡 down 也不重建连接（生产假阴性回归）", async () => {
    resetFakes();
    const manager = createManager();

    await manager.init();
    expect(await manager.checkConnection()).toBe(true);
    const original = FakeSurreal.created[0]!;
    expect(FakeSurreal.created).toHaveLength(1);

    // 1) 一次瞬断：探测失败 + 新连接建立持续失败（生产 F4 模式）。
    original.probeMode = "fail";
    FakeSurreal.defaultMode = "fail";
    expect(await manager.checkConnection()).toBe(false);
    expect(FakeSurreal.created).toHaveLength(2); // 只发起一次重连尝试

    // 2) 旧连接其实一直活着（生产证据：pool/worker 仍在服务）。
    //    /health 必须实测现有连接并恢复 ok，而不是永远卡 down。
    original.probeMode = "ok";
    expect(await manager.checkConnection()).toBe(true);
    // 恢复不换连接、不清池——没有连接风暴。
    expect(FakeSurreal.created).toHaveLength(2);
    expect(original.closed).toBe(false);
    expect(manager.snapshot().state).toBe("connected");

    await manager.close();
  });

  test("陈旧实例的 disconnected/error 事件不会翻转已恢复的健康状态", async () => {
    resetFakes();
    const manager = createManager();

    await manager.init();
    const stale = FakeSurreal.created[0]!;

    // 触发一次真实重连：探测失败 → 新连接成功 → 整体恢复 up。
    stale.probeMode = "fail";
    expect(await manager.checkConnection()).toBe(true);
    expect(FakeSurreal.created).toHaveLength(2);
    expect(manager.snapshot().state).toBe("connected");

    // 被替换掉的旧实例迟到发出事件（SDK close/error 异步发布）。
    stale.emit("disconnected");
    stale.emit("error", new Error("stale instance error"));

    expect(await manager.checkConnection()).toBe(true);
    expect(manager.snapshot().state).toBe("connected");
    // 没有因为陈旧事件发起多余重连。
    expect(FakeSurreal.created).toHaveLength(2);

    await manager.close();
  });

  test("重连单飞：并发健康检查在同一失败窗口只发起一次连接尝试", async () => {
    resetFakes();
    const manager = createManager();

    await manager.init();
    expect(FakeSurreal.created).toHaveLength(1);

    const original = FakeSurreal.created[0]!;
    original.probeMode = "fail";
    FakeSurreal.defaultMode = "hang"; // 新连接握手挂起

    const results = await Promise.all([
      manager.checkConnection(),
      manager.checkConnection(),
      manager.checkConnection(),
      manager.checkConnection(),
      manager.checkConnection(),
    ]);

    expect(results).toEqual([false, false, false, false, false]);
    // 单飞：5 次并发检查只创建了 1 个新连接实例（无连接风暴）。
    expect(FakeSurreal.created).toHaveLength(2);

    await manager.close();
  });

  test("真实不可达时如实报 down（不常 ok），恢复后自动转 ok", async () => {
    resetFakes();
    FakeSurreal.defaultMode = "fail";
    const manager = createManager();

    await manager.init();
    // 启动即不可达：如实 down。
    expect(await manager.checkConnection()).toBe(false);
    expect(manager.snapshot().state).toBe("disconnected");

    // 退避重试窗口内持续不可达：依然 down，绝不常 ok。
    for (let i = 0; i < 3; i += 1) {
      await Bun.sleep(60);
      expect(await manager.checkConnection()).toBe(false);
    }

    // DB 恢复：自治重连（退避定时器）必须把状态修回 connected。
    FakeSurreal.defaultMode = "ok";
    const deadline = Date.now() + 3_000;
    while (manager.snapshot().state !== "connected" && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(manager.snapshot().state).toBe("connected");
    expect(await manager.checkConnection()).toBe(true);

    await manager.close();
  });

  test("worker 环路瞬态错误后探针自愈：连接实际健康时不重建连接", async () => {
    resetFakes();
    const manager = createManager();

    await manager.init();
    expect(FakeSurreal.created).toHaveLength(1);

    // worker 某次查询报错，但底层连接其实健康（半开误报/瞬态）。
    manager.probeAfterWorkerError();
    await Bun.sleep(80);

    expect(manager.snapshot().state).toBe("connected");
    expect(FakeSurreal.created).toHaveLength(1);

    await manager.close();
  });

  test("重连最小间隔：失败后的密集检查不会加速重连（gate 防轮询风暴）", async () => {
    resetFakes();
    FakeSurreal.defaultMode = "fail";
    const manager = createManager(50);

    await manager.init();
    expect(FakeSurreal.created).toHaveLength(1);

    // 刚失败：最小间隔内不再发起新尝试，如实 down。
    expect(await manager.checkConnection()).toBe(false);
    expect(FakeSurreal.created).toHaveLength(1);

    // 间隔过后：才允许下一次尝试（仍然失败 → 仍 down）。
    await Bun.sleep(70);
    expect(await manager.checkConnection()).toBe(false);
    expect(FakeSurreal.created).toHaveLength(2);

    await manager.close();
  });

  test("close 后停止探测与重连", async () => {
    resetFakes();
    FakeSurreal.defaultMode = "fail";
    const manager = createManager();

    await manager.init();
    expect(await manager.checkConnection()).toBe(false);

    await manager.close();
    const before = FakeSurreal.created.length;
    await Bun.sleep(120);
    expect(FakeSurreal.created).toHaveLength(before);
    expect(await manager.checkConnection()).toBe(false);
    expect(manager.snapshot().state).toBe("disconnected");
  });
});

describe("nextBackoffDelayMs", () => {
  const backoff = [1000, 2000, 5000] as const;

  test("attempt 增大走退避序列并在末位封顶", () => {
    expect(nextBackoffDelayMs(0, backoff, () => 0.5)).toBe(1000);
    expect(nextBackoffDelayMs(1, backoff, () => 0.5)).toBe(2000);
    expect(nextBackoffDelayMs(2, backoff, () => 0.5)).toBe(5000);
    expect(nextBackoffDelayMs(9, backoff, () => 0.5)).toBe(5000);
  });

  test("jitter 控制在 ±20% 内", () => {
    const low = nextBackoffDelayMs(0, backoff, () => 0);
    const high = nextBackoffDelayMs(0, backoff, () => 1);
    expect(low).toBeGreaterThanOrEqual(800);
    expect(high).toBeLessThanOrEqual(1200);
    expect(low).toBeLessThanOrEqual(1000);
    expect(high).toBeGreaterThanOrEqual(1000);
  });
});
