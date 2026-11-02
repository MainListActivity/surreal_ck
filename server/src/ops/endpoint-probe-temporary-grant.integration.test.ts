import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { overrideEnv } from "../env";
import { seedPlatformOperators } from "../db/platform-operator-seed";
import {
  ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
  ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS,
  EndpointProbeTemporaryGrantService,
} from "./endpoint-probe-temporary-grant";
import { createPlatformOperatorCapabilityReader } from "./operator-auth";

const enabled = process.env.RUN_LOCAL_SURREALDB_PLATFORM_OPERATOR_LIST_TESTS === "1"
  || process.env.RUN_LOCAL_SURREALDB_ENDPOINT_PROBE_TEMPORARY_GRANT_TESTS === "1";
const localTest = test.skipIf(!enabled);
const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;

const GRANTOR = "grantor-subject";
const GRANTEE = "26dba3a6-4392-4840-a856-264d6f07fbee";
const OTHER = "8a41f4e7-41db-4784-a5e9-28b061124647";

let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];
let originalEnv: Record<string, unknown> = {};

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

async function session(database: string, namespace = "main"): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace, database });
  sessions.push(db);
  return db;
}

describe("endpoint probe temporary grant against company fork", () => {
  beforeAll(async () => {
    if (!enabled) return;
    const { env } = await import("../env");
    originalEnv = { ...env };
    const port = await freePort();
    endpoint = `ws://127.0.0.1:${port}`;
    processHandle = Bun.spawn(
      [surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`,
        "--user", "root", "--pass", "root", "memory"],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
      if (await ready.exited === 0) break;
      await Bun.sleep(100);
    }
    const root = await session("_system");
    await ensureSystemSchema(root, { namespace: "main" });
    await root.query(`
      CREATE platform_operator:grantor SET subject = $grantor, kind = "human", status = "active";
      CREATE platform_operator:grantee SET subject = $grantee, kind = "human", status = "active";
      CREATE platform_operator:other SET subject = $other, kind = "human", status = "active";
      CREATE platform_operator_capability:grantee_quota SET operator = platform_operator:grantee, capability = "quota.read", status = "active", granted_by_subject = "fixture";
      CREATE platform_operator_capability:grantor_quota SET operator = platform_operator:grantor, capability = "quota.read", status = "active", granted_by_subject = "fixture";
      CREATE platform_operator_capability:other_quota SET operator = platform_operator:other, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    `, { grantor: GRANTOR, grantee: GRANTEE, other: OTHER }).collect();
    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: GRANTEE,
      PLATFORM_OPERATOR_SUBJECTS: `${GRANTOR},${GRANTEE},${OTHER}`,
      PLATFORM_OPERATOR_CAPABILITIES: "quota.read,subscription.manage",
    } as never);
  }, 60_000);

  afterAll(async () => {
    for (const db of sessions.splice(0)) await db.close().catch(() => undefined);
    processHandle?.kill();
    if (enabled) overrideEnv(originalEnv as never);
  });

  localTest("046 表可用：单主体有效、其它拒绝、撤回/到期即时失效、seed 不复活临时权限、永久能力保留", async () => {
    let now = Date.parse("2026-11-02T09:00:00.000Z");
    const root = await session("_system");
    const service = new EndpointProbeTemporaryGrantService(async () => root, "main", () => now);
    const reader = createPlatformOperatorCapabilityReader(root, service);

    const before = await reader.getCapabilities(GRANTEE);
    expect(before).toEqual(["quota.read"]);

    const granted = await service.grant({ actorSubject: GRANTOR, reason: "fork-once" });
    expect(granted.status).toBe("active");
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["internal-ai.endpoint-probe", "quota.read"]);
    expect(await reader.getCapabilities(OTHER)).toEqual(["quota.read"]);

    await expect(service.grant({ actorSubject: OTHER })).rejects.toMatchObject({ status: 403 });

    const replay = await service.grant({ actorSubject: GRANTOR, reason: "fork-once" });
    expect(replay.notAfter).toBe(granted.notAfter);
    expect(replay.version).toBe(granted.version);

    await service.revoke({ actorSubject: GRANTOR, reason: "done" });
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read"]);
    const afterRevoke = await service.getStatusFor(GRANTEE);
    expect(afterRevoke.status).toBe("revoked");
    expect(afterRevoke.permanentActive).toBe(false);

    await service.grant({ actorSubject: GRANTOR });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read"]);
    expect((await service.getStatusFor(GRANTEE)).status).toBe("expired");

    // seed 只补永久表缺失项，且拒绝 CSV 含探针能力；临时表行保持过期/撤回，不会被写成永久 active。
    await expect(seedPlatformOperators(root, {
      subjectsCsv: `${GRANTOR},${GRANTEE}`,
      capabilitiesCsv: `quota.read,${ENDPOINT_PROBE_TEMPORARY_CAPABILITY}`,
    })).rejects.toThrow("temporary-grant control plane");
    await seedPlatformOperators(root, {
      subjectsCsv: `${GRANTOR},${GRANTEE}`,
      capabilitiesCsv: "quota.read,subscription.manage",
    });
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read", "subscription.manage"]);
    expect(await service.activeCapabilitiesFor(GRANTEE)).toEqual([]);
  }, 60_000);
});
