import { describe, expect, test, spyOn } from "bun:test";
import type { Surreal } from "surrealdb";
import { createEmployeeRuntime } from "./employee-runtime";

const target = { database: "ws_test", employeeId: "user:ve_test", subject: "SENSITIVE_SUBJECT", secret: "SENSITIVE_SECRET" };
const marker = "SENSITIVE_SECRET_TOKEN_ROOT_PAYLOAD";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture(options: {
  signin?: () => Promise<void>;
  close?: () => Promise<void>;
  auth?: () => Promise<unknown>;
  closeTimeoutMs?: number;
  onSessionClosed?: (database: string, employeeId: string) => void;
} = {}) {
  let connects = 0;
  let live = 0;
  let peak = 0;
  let probes = 0;
  const runtime = createEmployeeRuntime({
    surrealUrl: "wss://example.test/rpc", namespace: "main", probeTimeoutMs: 10,
    ...(options.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
    ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
    connect: () => {
      connects++;
      let closed = false;
      return {
        async connect() { live++; peak = Math.max(peak, live); },
        async signin() { await options.signin?.(); },
        async close() {
          await options.close?.();
          if (!closed) { closed = true; live--; }
        },
        async auth() {
          probes++;
          return options.auth ? options.auth() : { id: target.employeeId, virtual_profile: { status: "active" }, secret: marker };
        },
      } as unknown as Surreal;
    },
  });
  return { runtime, counts: () => ({ connects, live, peak, probes }), inspect: () => runtime.inspect(target.database, target.employeeId) };
}

describe("employee runtime controlled observation", () => {
  test("同一连接固定 SDK auth 探测；pause/resume 新代次；重复并发操作无双连接", async () => {
    const f = fixture();
    const empty = await f.inspect();
    expect(empty).toMatchObject({ usable: false, probeCode: "absent", closeConfirmed: null });
    expect(f.counts().connects).toBe(0);
    await f.runtime.register(target);
    const active = await f.inspect();
    expect(active).toMatchObject({ usable: true, sessionPresent: true, connectionCount: 1, generation: 1, probeCode: "ok" });
    expect(active.lastRegisteredAt).not.toBeNull();
    expect(JSON.stringify(active)).not.toContain(marker);
    expect(f.counts()).toEqual({ connects: 1, live: 1, peak: 1, probes: 1 });
    await Promise.all([f.runtime.close(target.database, target.employeeId, { deactivate: true }), f.runtime.close(target.database, target.employeeId, { deactivate: true })]);
    const paused = await f.inspect();
    expect(paused).toMatchObject({ usable: false, sessionPresent: false, connectionCount: 0, closeConfirmed: true, generation: 1 });
    expect(paused.lastClosedAt).not.toBeNull();
    expect(f.counts().live).toBe(0);
    await expect(f.runtime.openSession(target.database, target.employeeId)).rejects.toThrow("employee-session-blocked");
    await expect(f.runtime.register(target)).rejects.toThrow("employee-session-blocked");
    await f.runtime.register(target, { activate: true });
    expect(await f.inspect()).toMatchObject({ instanceId: active.instanceId, usable: true, generation: 2 });
    await Promise.all([f.runtime.register(target), f.runtime.register(target)]);
    expect(f.counts()).toMatchObject({ live: 1, peak: 1 });
    await f.runtime.close(target.database, target.employeeId, { forgetSecret: true });
    expect(await f.inspect()).toMatchObject({ closeConfirmed: true, usable: false });
    await expect(f.runtime.register(target, { activate: true })).rejects.toThrow("employee-session-blocked");
    await f.runtime.stop();
  });

  test("普通窗口关闭后可再次显式注册；生命周期暂停不会被窗口 close 解除", async () => {
    const f = fixture();
    await f.runtime.register(target);
    await f.runtime.close(target.database, target.employeeId);
    expect(await f.inspect()).toMatchObject({ closeConfirmed: true, usable: false, connectionCount: 0 });
    await f.runtime.openSession(target.database, target.employeeId);
    expect(await f.inspect()).toMatchObject({ usable: true, generation: 2, connectionCount: 1 });
    await f.runtime.close(target.database, target.employeeId, { deactivate: true });
    await f.runtime.close(target.database, target.employeeId);
    await expect(f.runtime.openSession(target.database, target.employeeId)).rejects.toThrow("employee-session-blocked");
    await f.runtime.stop();
  });

  test("实际 close 完成前不确认；失败去敏并保留重试；替换不遗留新连接", async () => {
    const gate = deferred();
    let fail = true;
    const logs: unknown[] = [];
    const spy = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    try {
      const f = fixture({ close: async () => { await gate.promise; if (fail) throw new Error(marker); } });
      await f.runtime.register(target);
      const close = f.runtime.close(target.database, target.employeeId, { deactivate: true });
      expect(f.runtime.session(target.database, target.employeeId)).toBeUndefined();
      expect(await f.inspect()).toMatchObject({ closeConfirmed: null, usable: false });
      gate.resolve();
      await expect(close).rejects.toThrow("employee-close-failed");
      expect(await f.inspect()).toMatchObject({ closeConfirmed: false, lastClosedAt: null, usable: false });
      await expect(f.runtime.register(target, { activate: true })).rejects.toThrow("employee-close-failed");
      expect(f.counts()).toMatchObject({ live: 1, connects: 1 });
      fail = false;
      await f.runtime.close(target.database, target.employeeId, { deactivate: true });
      expect(await f.inspect()).toMatchObject({ closeConfirmed: true });
      expect(f.counts().live).toBe(0);
      await f.runtime.stop();
      expect(JSON.stringify(logs)).not.toContain(marker);
      expect(JSON.stringify(logs)).not.toContain(target.secret);
      expect(JSON.stringify(logs)).not.toContain(target.subject);
    } finally { spy.mockRestore(); }
  });

  test("inflight SIGNIN 与 pause/retire 并发：等待关闭，旧注册永不回填", async () => {
    for (const forgetSecret of [false, true]) {
      const gate = deferred();
      const entered = deferred();
      const f = fixture({ signin: async () => { entered.resolve(); await gate.promise; } });
      const register = f.runtime.register(target);
      await entered.promise;
      const queued = f.runtime.register(target);
      void queued.catch(() => undefined);
      const close = f.runtime.close(target.database, target.employeeId, { forgetSecret, deactivate: true });
      let completed = false;
      void close.then(() => { completed = true; });
      await Promise.resolve();
      expect(completed).toBe(false);
      gate.resolve();
      await expect(register).rejects.toThrow("employee-session-blocked");
      await expect(queued).rejects.toThrow("employee-session-blocked");
      await close;
      expect(f.counts()).toMatchObject({ live: 0, connects: 1 });
      expect(await f.inspect()).toMatchObject({ generation: 0, sessionPresent: false, closeConfirmed: true });
      await expect(f.runtime.openSession(target.database, target.employeeId)).rejects.toThrow("employee-session-blocked");
      await f.runtime.stop();
    }
  });

  test("stop 等待 inflight 注册清理，不遗留连接", async () => {
    const gate = deferred();
    const entered = deferred();
    const f = fixture({ signin: async () => { entered.resolve(); await gate.promise; } });
    const register = f.runtime.register(target);
    await entered.promise;
    const stop = f.runtime.stop();
    gate.resolve();
    await expect(register).rejects.toThrow("employee-runtime-stopped");
    await stop;
    expect(f.counts().live).toBe(0);
  });

  test("timeout、错误、错误身份、非 active 均不可用；probe 不注册重连", async () => {
    for (const auth of [
      () => new Promise<never>(() => {}),
      async () => { throw new Error(marker); },
      async () => ({ id: "user:foreign", virtual_profile: { status: "active" }, token: marker }),
      async () => ({ id: target.employeeId, virtual_profile: { status: "paused" } }),
    ]) {
      const f = fixture({ auth });
      await f.runtime.register(target);
      const result = await f.inspect();
      expect(result.usable).toBe(false);
      expect(["timeout", "unavailable"]).toContain(result.probeCode);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(f.counts().connects).toBe(1);
      await f.runtime.stop();
    }
  });

  test("probe 与关闭/替换竞争时 fail closed", async () => {
    const gate = deferred();
    const entered = deferred();
    const f = fixture({ auth: async () => {
      entered.resolve(); await gate.promise;
      return { id: target.employeeId, virtual_profile: { status: "active" } };
    } });
    await f.runtime.register(target);
    const probe = f.inspect();
    await entered.promise;
    await f.runtime.close(target.database, target.employeeId, { deactivate: true });
    await f.runtime.register(target, { activate: true });
    gate.resolve();
    expect(await probe).toMatchObject({ usable: false, probeCode: "changed", generation: 2 });
    await f.runtime.stop();
  });

  test("SIGNIN 敏感错误只返回稳定码；日志不含目标凭证", async () => {
    const logs: unknown[] = [];
    const spy = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    try {
      const f = fixture({ signin: async () => { throw new Error(marker); } });
      await expect(f.runtime.register(target)).rejects.toThrow("employee-signin-failed");
      expect(f.counts().live).toBe(0);
      expect(JSON.stringify(logs)).not.toContain(marker);
      expect(JSON.stringify(logs)).not.toContain(target.subject);
      await f.runtime.stop();
    } finally { spy.mockRestore(); }
  });

  test("D1：僵尸连接的 close 悬挂时有界收敛——注册表摘除、观测不再假健康", async () => {
    const logs: unknown[] = [];
    const spy = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    try {
      const f = fixture({ close: () => new Promise<never>(() => {}), closeTimeoutMs: 20 });
      await f.runtime.register(target);
      // 生命周期关闭：close 悬挂，但有界超时后如实失败，绝不定卡。
      await expect(
        f.runtime.close(target.database, target.employeeId, { deactivate: true }),
      ).rejects.toThrow("employee-close-failed");
      // 注册表已同步摘除：观测立即如实（sessionPresent=false → usable=false），
      // closeConfirmed=false 标记关闭未确认——不再报 usable=true 假健康。
      expect(await f.inspect()).toMatchObject({
        sessionPresent: false,
        usable: false,
        closeConfirmed: false,
        connectionCount: 1, // 关闭失败的连接仍计数（含连接中/关闭失败语义）
      });
      // stop 对僵尸连接的关闭同样有界失败（既有 throw 语义），不再悬挂。
      await expect(f.runtime.stop()).rejects.toThrow("employee-close-failed");
    } finally { spy.mockRestore(); }
  });

  test("D1：会话失效通知——有真实会话被拆除/替换时触发；通知条件随会话存在性", async () => {
    const notified: Array<[string, string]> = [];
    const f = fixture({
      onSessionClosed: (database, employeeId) => notified.push([database, employeeId]),
    });
    // 首次注册（无旧会话可拆）：不通知。
    await f.runtime.register(target);
    expect(notified).toHaveLength(0);
    // 有会话的拆除（lane 空闲收尾或生命周期都走这里）：通知——
    // 回调动作（清 lane 缓存/中止在途窗口）对两种来源都安全。
    await f.runtime.close(target.database, target.employeeId);
    expect(notified).toEqual([["ws_test", "user:ve_test"]]);
    // 无会话可拆（已关闭）：不重复通知。
    await f.runtime.close(target.database, target.employeeId, { deactivate: true });
    expect(notified).toHaveLength(1);
    // register 换代次（有活跃会话被替换）：通知。
    await f.runtime.register(target, { activate: true });
    expect(notified).toHaveLength(1);
    await f.runtime.register(target);
    expect(notified).toHaveLength(2);
    await f.runtime.stop();
  });
});
