import { expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { createRootConnectionManager } from "./root-connection";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Connection {
  closed = false;
  useCalls = 0;
  failConnect = false;
  connectGate: Promise<void> = Promise.resolve();
  queryGate: () => Promise<unknown> = async () => [];

  subscribe() {
    return () => {};
  }
  async connect() {
    if (this.failConnect) throw new Error("new handshake fails while current connection healthy");
    await this.connectGate;
    this.closed = false; // 模拟 close 后仍迟到完成的 SDK 握手
  }
  async use() {
    this.useCalls += 1;
  }
  async close() {
    this.closed = true;
  }
  query() {
    return this.queryGate();
  }
}

for (const failExtraHandshake of [false, true]) test(`迟到旧探测失败不能误改健康新实例，额外握手失败=${failExtraHandshake}`, async () => {
  const instances: Connection[] = [];
  let now = 10000;
  const manager = createRootConnectionManager({
    createSurreal: () => {
      const connection = new Connection();
      instances.push(connection);
      connection.failConnect = failExtraHandshake && instances.length > 2;
      return connection as unknown as Surreal;
    },
    now: () => now,
    backoffMs: [60000],
    random: () => 0.5,
  });
  await manager.init();
  const old = instances[0]!;
  const slow = deferred();
  old.queryGate = () => slow.promise;
  const first = manager.checkConnection();
  old.queryGate = async () => { throw new Error("second probe detects disconnect"); };
  now += 2000;
  expect(await manager.checkConnection()).toBe(true);
  expect(instances.length).toBe(2);
  now += 2000;
  slow.reject(new Error("late failure from replaced instance"));
  const lateResult = await first;
  const snapshot = manager.snapshot();
  const healthyClosed = instances[1]!.closed;
  await manager.close();
  expect(lateResult).toBe(true);
  expect(snapshot.state).toBe("connected");
  expect(healthyClosed).toBe(false);
  expect(instances.length).toBe(2);
});

test("close 期间在途 connect 完成不能复活管理器或遗留开放连接", async () => {
  const gate = deferred();
  const connection = new Connection();
  connection.connectGate = gate.promise;
  const manager = createRootConnectionManager({ createSurreal: () => connection as unknown as Surreal });
  const init = manager.init();
  await manager.close();
  expect(connection.closed).toBe(true);
  gate.resolve();
  // 在途 init 已被取消；等待迟到握手及其清理的微任务完成。
  await init;
  await Bun.sleep(0);
  const snapshot = manager.snapshot();
  const closed = connection.closed;
  const health = await manager.checkConnection();
  await manager.close();
  expect(snapshot.state).toBe("disconnected");
  expect(closed).toBe(true);
  expect(health).toBe(false);
  expect(connection.useCalls).toBe(0);
  expect(() => manager.getConnection()).toThrow("not initialized");
});

for (const alive of [false, true]) test(`close 使在途探测结果失效，迟到成功=${alive}`, async () => {
  const connection = new Connection();
  const gate = deferred();
  const manager = createRootConnectionManager({ createSurreal: () => connection as unknown as Surreal });
  await manager.init();
  connection.queryGate = () => gate.promise;
  const check = manager.checkConnection();
  await manager.close();
  if (alive) gate.resolve();
  else gate.reject(new Error("late probe failure after close"));
  expect(await check).toBe(false);
  expect(manager.snapshot().state).toBe("disconnected");
});

for (const alive of [false, true]) test(`旧生命周期探测不能污染重新 init 的管理器，迟到成功=${alive}`, async () => {
  const instances: Connection[] = [];
  const manager = createRootConnectionManager({
    createSurreal: () => {
      const connection = new Connection();
      instances.push(connection);
      return connection as unknown as Surreal;
    },
    minReconnectIntervalMs: 0,
  });
  await manager.init();
  const gate = deferred();
  instances[0]!.queryGate = () => gate.promise;
  const oldCheck = manager.checkConnection();
  await manager.close();
  await manager.init();
  if (alive) gate.resolve();
  else gate.reject(new Error("old lifecycle failed"));
  const result = await oldCheck;
  const snapshot = manager.snapshot();
  const healthyClosed = instances[1]!.closed;
  await manager.close();
  expect(result).toBe(false);
  expect(snapshot.state).toBe("connected");
  expect(healthyClosed).toBe(false);
  expect(instances.length).toBe(2);
});

test("旧探测迟到成功不能掩盖当前实例的真实不可达", async () => {
  const instances: Connection[] = [];
  let now = 10000;
  const manager = createRootConnectionManager({
    createSurreal: () => {
      const connection = new Connection();
      instances.push(connection);
      return connection as unknown as Surreal;
    },
    now: () => now,
    backoffMs: [60000],
  });
  await manager.init();
  const gate = deferred();
  instances[0]!.queryGate = () => gate.promise;
  const oldCheck = manager.checkConnection();
  instances[0]!.queryGate = async () => { throw new Error("disconnected"); };
  now += 2000;
  expect(await manager.checkConnection()).toBe(true);
  // 新连接随后不可达；gate 尚未过，不能用旧实例的成功结果报 up。
  instances[1]!.queryGate = async () => { throw new Error("current instance down"); };
  gate.resolve();
  const result = await oldCheck;
  await manager.close();
  expect(result).toBe(false);
  expect(instances.length).toBe(2);
});

test("超时的握手迟到成功也会清理候选且不发布连接", async () => {
  const gate = deferred();
  const connection = new Connection();
  connection.connectGate = gate.promise;
  const manager = createRootConnectionManager({
    createSurreal: () => connection as unknown as Surreal,
    connectTimeoutMs: 10,
    backoffMs: [60000],
  });
  await manager.init();
  expect(connection.closed).toBe(true);
  gate.resolve();
  await Bun.sleep(0);
  const snapshot = manager.snapshot();
  const closed = connection.closed;
  await manager.close();
  expect(snapshot.state).toBe("disconnected");
  expect(closed).toBe(true);
  expect(connection.useCalls).toBe(0);
  expect(() => manager.getConnection()).toThrow("not initialized");
});

test("旧连接在重连握手期间探测自愈：取消候选，所有检查报告真实恢复", async () => {
  const gate = deferred();
  const original = new Connection();
  const candidate = new Connection();
  candidate.connectGate = gate.promise;
  let created = 0;
  const manager = createRootConnectionManager({
    createSurreal: () => (++created === 1 ? original : candidate) as unknown as Surreal,
    minReconnectIntervalMs: 0,
    backoffMs: [60000],
  });
  await manager.init();
  original.queryGate = async () => { throw new Error("transient probe failure"); };
  const pendingCheck = manager.checkConnection();
  // 让失败探测进入新握手；随后另一探测实测旧连接已经恢复。
  await Bun.sleep(0);
  original.queryGate = async () => [];
  expect(await manager.checkConnection()).toBe(true);
  gate.reject(new Error("new connection unavailable"));
  const pendingResult = await pendingCheck;
  const retained = manager.getConnection();
  const closed = original.closed;
  await manager.close();
  expect(pendingResult).toBe(true);
  expect(retained).toBe(original as unknown as Surreal);
  expect(closed).toBe(false);
  expect(candidate.closed).toBe(true);
  expect(created).toBe(2);
});
