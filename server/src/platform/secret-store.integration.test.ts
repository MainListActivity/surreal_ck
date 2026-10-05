import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { PlatformSecretStore } from "./secret-store";

const enabled = process.env.RUN_LOCAL_SURREALDB_SECRET_STORE_TESTS === "1";
const localTest = test.skipIf(!enabled);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function session(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "main", database });
  sessions.push(db);
  return db;
}

beforeAll(async () => {
  if (!enabled) return;
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn([surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session("_system");
  await ensureSystemSchema(root, { namespace: "main" });
});

afterAll(async () => {
  await Promise.all(sessions.map(async (db) => { await db.close(); }));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("PlatformSecretStore 真实仓回路（生产两轮 500 回归）", () => {
  localTest("put → get/describe 经真实 SDK query 形状回读成功，密文行与审计事件落库", async () => {
    const store = new PlatformSecretStore(KEY_A, async (database) => await session(database));
    await store.put("idp_provision_token", "tok-SECRET-first", {
      actor: "ops:integration-1",
      purpose: "idp provision token",
      detail: { verifiedAgainst: "GET /admin/tenants" },
    });
    const first = await store.get("idp_provision_token");
    expect(first?.value).toBe("tok-SECRET-first");
    expect(first?.updatedBy).toBe("ops:integration-1");
    const meta = await store.describe("idp_provision_token");
    expect(meta).toMatchObject({
      name: "idp_provision_token",
      purpose: "idp provision token",
      updatedBy: "ops:integration-1",
    });

    await store.put("idp_provision_token", "tok-SECRET-second", {
      actor: "ops:integration-2",
      action: "rotate",
    });
    expect((await store.get("idp_provision_token"))?.value).toBe("tok-SECRET-second");
    expect((await store.describe("idp_provision_token"))?.updatedBy).toBe("ops:integration-2");

    const root = sessions[0]!;
    const [secretRows] = await root.query<[{ envelope: string; name: string }[]]>(
      "SELECT name, envelope FROM platform_secret;",
    );
    expect(secretRows).toHaveLength(1);
    expect(secretRows[0]!.name).toBe("idp_provision_token");
    expect(secretRows[0]!.envelope).not.toContain("tok-SECRET");
    const [eventRows] = await root.query<[
      { secret_name: string; action: string; actor_subject: string; source: string; detail: unknown; occurred_at: unknown }[],
    ]>(
      "SELECT * FROM platform_secret_event ORDER BY occurred_at;",
    );
    expect(eventRows).toHaveLength(2);
    expect(eventRows[0]).toMatchObject({
      secret_name: "idp_provision_token",
      action: "rotate",
      actor_subject: "ops:integration-1",
      source: "ops_api",
      detail: { verifiedAgainst: "GET /admin/tenants" },
    });
    expect(eventRows[1]).toMatchObject({
      secret_name: "idp_provision_token",
      action: "rotate",
      actor_subject: "ops:integration-2",
    });
    expect(JSON.stringify(eventRows)).not.toContain("tok-SECRET");

    const wrongKey = new PlatformSecretStore(KEY_B, async (database) => await session(database));
    await expect(wrongKey.get("idp_provision_token")).rejects.toMatchObject({
      code: "secret-unseal-failed",
    });
    await expect(store.get("missing_secret")).resolves.toBeNull();
    await expect(store.describe("missing_secret")).resolves.toBeNull();
  }, 60_000);
});
