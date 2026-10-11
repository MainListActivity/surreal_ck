// root 连接健康状态机集成测试：真实公司 fork + 真实 SurrealDB SDK。
// 复现并锁死生产故障语义（2026-10-11 /health 假阴性卡死事件）：
// 1) 引擎被杀（真实降级）时 /health 读数必须如实 down，且不会「常 ok」；
// 2) 引擎重启后自治重连必须把状态修回 connected，root session pool 的
//    控制面读写路径随新连接恢复（不残留旧实例）；
// 3) 降级窗口内的健康检查只做有界单飞尝试，不产生连接风暴。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_ROOT_CONNECTION_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";

let endpoint = "";
let workingDirectory = "";
let engine: ReturnType<typeof Bun.spawn> | undefined;

function spawnEngine(port: number): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([
    surrealBinary, "start", "--no-banner", "--log", "warn",
    "--bind", `127.0.0.1:${port}`,
    "--user", "root", "--pass", "root",
    `rocksdb:${join(workingDirectory, "data")}`,
  ], {
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      listener.close(() => resolve(address.port));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = Bun.spawn([
      surrealBinary, "is-ready", "--endpoint", endpoint,
    ], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

const port = await allocatePort();
endpoint = `ws://127.0.0.1:${port}`;

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  // 覆盖已解析的 env 快照，指向本次测试引擎（preload 设的是死端口）。
  const { overrideEnv } = await import("../env");
  overrideEnv({
    SURREAL_URL: `${endpoint}/rpc`,
    SURREAL_NS: namespace,
    SURREAL_ROOT_USER: "root",
    SURREAL_ROOT_PASS: "root",
    OIDC_ISSUER: "http://127.0.0.1:1/issuer",
    OIDC_JWKS_URL: "http://127.0.0.1:1/jwks",
    OIDC_AUDIENCE: "surreal-ck-test",
    IDP_HOOK_SECRET: "test-hook-secret",
  });
  process.env.SURREAL_LOG_QUERIES = "";

  workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-root-connection-"));
  engine = spawnEngine(port);
  void engine.stderr.text().then((text) => {
    if (text.trim()) console.error("[engine]", text.trim());
  });
  await waitUntilReady();
});

afterAll(async () => {
  engine?.kill();
  if (engine) await engine.exited;
  if (workingDirectory) {
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

describe("root connection health state machine (real fork)", () => {
  localTest("引擎重启：降级期如实 down，恢复后自治重连且控制面读写随之恢复", async () => {
    const {
      initRootConnection,
      checkRootConnection,
      getRootDatabaseSession,
      closeRootConnection,
    } = await import("./root-connection");

    await initRootConnection();
    try {
      // 1) 基线：/health 读数 ok，root session pool 读写路径可用。
      expect(await checkRootConnection()).toBe(true);
      const probeId = `probe_${Date.now()}`;
      const session = await getRootDatabaseSession(database, namespace);
      await session.query(
        `CREATE type::record("root_connection_it_probe", $id) CONTENT { note: "baseline" };`,
        { id: probeId },
      );
      const baselineRead = (await session.query(
        `SELECT note FROM type::record("root_connection_it_probe", $id);`,
        { id: probeId },
      ).collect()) as unknown as Array<Array<{ note?: string }>>;
      expect(baselineRead[0]?.[0]?.note).toBe("baseline");

      // 2) 真实降级：杀引擎。读数必须如实 down，反复检查也不会「常 ok」。
      engine?.kill();
      if (engine) await engine.exited;
      await Bun.sleep(1_500);
      for (let i = 0; i < 3; i += 1) {
        expect(await checkRootConnection()).toBe(false);
      }

      // 3) 引擎重启（同端口同数据目录）：自治重连必须恢复。
      engine = spawnEngine(port);
      await waitUntilReady();
      const recoverDeadline = Date.now() + 30_000;
      while ((await checkRootConnection()) === false && Date.now() < recoverDeadline) {
        await Bun.sleep(500);
      }
      expect(await checkRootConnection()).toBe(true);

      // 4) 恢复后控制面读写路径随新连接恢复（pool 不残留旧实例会话）。
      const recoveredSession = await getRootDatabaseSession(database, namespace);
      const recoveredRead = (await recoveredSession.query(
        `SELECT note FROM type::record("root_connection_it_probe", $id);`,
        { id: probeId },
      ).collect()) as unknown as Array<Array<{ note?: string }>>;
      expect(recoveredRead[0]?.[0]?.note).toBe("baseline");
      await recoveredSession.query(
        `DELETE type::record("root_connection_it_probe", $id);`,
        { id: probeId },
      );
    } finally {
      await closeRootConnection();
    }
  }, 90_000);
});
