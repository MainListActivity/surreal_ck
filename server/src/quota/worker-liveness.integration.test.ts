// LCA 控制面 worker 存活性集成测试：真实公司 fork + 真实 startNativeQuotaRuntime。
// 复现并锁死生产故障机制：连接实例被启动期捕获后，DB 侧断连（引擎重启模拟）
// 会让 worker 永久打在已关闭的旧连接上——HTTP /health 仍正常。
// 修复语义：稳定引用按调用时刻解析当前连接，重启后下一 tick 即恢复领取；
// 心跳固定行 UPSERT 落 _system，供 ops/QA 读取最近推进。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Surreal, StringRecordId } from "surrealdb";
import { seedQuotaPlans } from "../db/quota-plan-seed";
import { SurrealQuotaLifecycleStore } from "./lifecycle-store";
import { QuotaLifecycleCoordinator } from "./subscription-lifecycle";

const RUN_INTEGRATION =
  process.env.RUN_LOCAL_SURREALDB_QUOTA_LIFECYCLE_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);

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
  // 必须经 overrideEnv 覆盖**已解析**的 env 对象：preload 在模块导入前就
  // 把 SURREAL_URL 设成了死端口，env.ts 已按它完成校验与冻结快照。
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

  workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-worker-liveness-"));
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

async function applyMigrations(db: Surreal): Promise<void> {
  const entries = (await readdir(migrationsUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  for (const entry of entries) {
    await db.query(await readFile(new URL(entry, migrationsUrl), "utf8"));
  }
}

async function seedFixture(db: Surreal): Promise<void> {
  await db.query(`
    CREATE workspace:acme CONTENT {
      db_name: "ws_acme",
      owner_subject: "operator:alice",
      slug: "acme",
      name: "Acme",
      status: "active"
    };
    CREATE platform_operator:alice CONTENT {
      subject: "operator:alice",
      display_name: "Alice",
      status: "active"
    };
    CREATE platform_operator_capability:alice_reconcile CONTENT {
      operator: platform_operator:alice,
      capability: "reconcile.audit",
      status: "active",
      granted_by_subject: "system:test"
    };
  `);
}

function coordinatorOn(client: Surreal): QuotaLifecycleCoordinator {
  return new QuotaLifecycleCoordinator(
    new SurrealQuotaLifecycleStore(client),
    { async refreshWorkspace() { return {}; } },
  );
}

async function submitReconcileIntent(
  client: Surreal,
  requestId: string,
): Promise<string> {
  const result = await coordinatorOn(client).submitOperatorIntent({
    kind: "reconcile_now",
    actorSubject: "operator:alice",
    actorCapability: "reconcile.audit",
    requestId,
    workspace: new StringRecordId("workspace:acme"),
    customerReason: "worker liveness 集成测试",
    operatorReason: "验证到点意图被持续领取",
    effectiveAt: DateTime.fromEpochNanoseconds(
      BigInt(Date.now()) * 1_000_000n,
    ),
    input: { workspace: "workspace:acme" },
    impactPreview: { kind: "reconcile_now" },
    correlationId: `corr-${requestId}`,
  });
  return result.intent.toString();
}

type IntentStateRow = {
  id: string;
  state: string;
  attempt_count: number;
  updated_at: string;
};

async function intentStateRow(
  client: Surreal,
  intentId: string,
): Promise<IntentStateRow | undefined> {
  const rows = (await client.query(
    "SELECT id, state, attempt_count, updated_at FROM quota_operator_intent_state WHERE intent = $intent;",
    { intent: new StringRecordId(intentId) },
  ).collect()) as unknown as IntentStateRow[][];
  return rows[0]?.[0];
}

describe("quota worker liveness (real fork)", () => {
  localTest(
    "重启级断连后 worker 恢复领取且心跳固定行幂等更新",
    async () => {
      const { initRootConnection, closeRootConnection } = await import(
        "../db/root-connection"
      );
      const { ensureSystemSchema } = await import("../db/system-schema");
      const { startNativeQuotaRuntime } = await import("./runtime");

      await initRootConnection();
      await ensureSystemSchema();

      const seed = new Surreal();
      await seed.connect(`${endpoint}/rpc`, {
        authentication: { username: "root", password: "root" },
      });
      await seed.use({ namespace, database });
      await applyMigrations(seed);
      await seedFixture(seed);
      await seedQuotaPlans({
        namespace,
        createdBySubject: "system:test",
        getDbSession: async () => seed,
      });

      const submitClient = new Surreal();
      await submitClient.connect(`${endpoint}/rpc`, {
        authentication: { username: "root", password: "root" },
      });
      await submitClient.use({ namespace, database });

      // 真实 worker 环路（生产装配同款）。
      const runtime = startNativeQuotaRuntime();
      try {
        // 1) 基线：合法已到点意图被领取并完成。
        const intentA = await submitReconcileIntent(
          submitClient,
          `liveness-a-${Date.now()}`,
        );
        let row = await intentStateRow(submitClient, intentA);
        const deadline = Date.now() + 15_000;
        while (
          (row?.state !== "processed" || (row?.attempt_count ?? 0) < 1)
          && Date.now() < deadline
        ) {
          await Bun.sleep(500);
          row = await intentStateRow(submitClient, intentA);
        }
        expect(row?.state).toBe("processed");
        expect(row?.attempt_count).toBe(1);

        // 2) 心跳固定行已落库且指向当前 worker。
        const heartbeatRows = (await seed.query(
          "SELECT id, loop, worker_id, tick_count, last_success_at FROM quota_worker_heartbeat:operator_intents;",
        ).collect()) as unknown as Array<Array<Record<string, unknown>>>;
        const heartbeat = heartbeatRows[0]?.[0];
        expect(heartbeat).toBeDefined();
        expect(heartbeat?.loop).toBe("operator-intents");
        expect(String(heartbeat?.worker_id)).toContain("quota:");
        expect(Number(heartbeat?.tick_count)).toBeGreaterThanOrEqual(1);

        // 3) DB 侧断连（杀引擎重启同端口同数据目录）→ worker 必须恢复。
        engine?.kill();
        if (engine) await engine.exited;
        await Bun.sleep(1_500);
        const restartedAt = new Date();
        engine = spawnEngine(port);
        await waitUntilReady();

        const intentB = await submitReconcileIntent(
          submitClient,
          `liveness-b-${Date.now()}`,
        );
        row = await intentStateRow(submitClient, intentB);
        const recoverDeadline = Date.now() + 60_000;
        while (
          (row?.state !== "processed" || (row?.attempt_count ?? 0) < 1)
          && Date.now() < recoverDeadline
        ) {
          await Bun.sleep(1_000);
          row = await intentStateRow(submitClient, intentB);
        }
        expect(row?.state).toBe("processed");
        expect(row?.attempt_count).toBe(1);

        // 4) 心跳同 id 覆盖（不累积）：等节流窗口后的新心跳落到重启后的连接上。
        let after: Record<string, unknown> | undefined;
        const heartbeatDeadline = Date.now() + 20_000;
        while (Date.now() < heartbeatDeadline) {
          await Bun.sleep(1_000);
          const afterRows = (await seed.query(
            "SELECT id, worker_id, tick_count, last_success_at, updated_at FROM quota_worker_heartbeat:operator_intents;",
          ).collect()) as unknown as Array<Array<Record<string, unknown>>>;
          const candidate = afterRows[0]?.[0];
          const updatedAt = candidate
            ? new Date(String(candidate.updated_at)).getTime()
            : 0;
          if (updatedAt > restartedAt.getTime()) {
            after = candidate;
            break;
          }
        }
        expect(after).toBeDefined();
        expect(String(after?.id)).toBe(
          "quota_worker_heartbeat:operator_intents",
        );
        expect(String(after?.worker_id)).toBe(String(heartbeat?.worker_id));
        // 心跳写有节流，重启恢复后计数不回退即可（新鲜度由 updated_at 判定）。
        expect(Number(after?.tick_count)).toBeGreaterThanOrEqual(
          Number(heartbeat?.tick_count),
        );
      } finally {
        runtime.stop();
        await closeRootConnection();
        await seed.close();
        await submitClient.close();
      }
    },
    240_000,
  );
});
