import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
  SurrealTemporaryGrantStore,
  type TemporaryGrantStore,
} from "./endpoint-probe-temporary-grant";
import { createPlatformOperatorCapabilityReader } from "./operator-auth";

const enabled = process.env.RUN_LOCAL_SURREALDB_PLATFORM_OPERATOR_LIST_TESTS === "1"
  || process.env.RUN_LOCAL_SURREALDB_ENDPOINT_PROBE_TEMPORARY_GRANT_TESTS === "1";
const localTest = test.skipIf(!enabled);
const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;

const GRANTOR = "grantor-subject";
const GRANTEE = "26dba3a6-4392-4840-a856-264d6f07fbee";
const OTHER = "8a41f4e7-41db-4784-a5e9-28b061124647";
const DISABLED = "disabled-subject";
const CONFIG_B = "config-b-subject";
const PERM = "permanent-subject";
const RACE = "race-subject";

let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];
let originalEnv: Record<string, unknown> = {};
let root: Surreal;

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

function makeService(now: () => number): EndpointProbeTemporaryGrantService {
  return new EndpointProbeTemporaryGrantService(
    new SurrealTemporaryGrantStore(async () => root, "main"),
    now,
  );
}

function setGrantee(subject: string | undefined): void {
  overrideEnv({ ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: subject } as never);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function resetFixtures(): Promise<void> {
  await root.query(`
    DELETE platform_operator_temporary_grant;
    DELETE platform_operator_temporary_grant_request;
    DELETE platform_operator_capability;
    DELETE platform_operator;
  `);
  await root.query(`
    CREATE platform_operator:grantor SET subject = $grantor, kind = "human", status = "active";
    CREATE platform_operator:grantee SET subject = $grantee, kind = "human", status = "active";
    CREATE platform_operator:other SET subject = $other, kind = "human", status = "active";
    CREATE platform_operator:disabled SET subject = $disabled, kind = "human", status = "active";
    CREATE platform_operator:config_b SET subject = $configB, kind = "human", status = "active";
    CREATE platform_operator:perm SET subject = $perm, kind = "human", status = "active";
    CREATE platform_operator:race SET subject = $race, kind = "human", status = "active";
    CREATE platform_operator_capability:grantor_quota SET operator = platform_operator:grantor, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:grantee_quota SET operator = platform_operator:grantee, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:other_quota SET operator = platform_operator:other, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:disabled_quota SET operator = platform_operator:disabled, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:config_b_quota SET operator = platform_operator:config_b, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:perm_quota SET operator = platform_operator:perm, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:race_quota SET operator = platform_operator:race, capability = "quota.read", status = "active", granted_by_subject = "fixture";
  `, {
    grantor: GRANTOR,
    grantee: GRANTEE,
    other: OTHER,
    disabled: DISABLED,
    configB: CONFIG_B,
    perm: PERM,
    race: RACE,
  });
}

async function resetTemporaryRows(): Promise<void> {
  await root.query(`
    DELETE platform_operator_temporary_grant;
    DELETE platform_operator_temporary_grant_request;
  `);
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
    root = await session("_system");
    await ensureSystemSchema(root, { namespace: "main" });
    await resetFixtures();
    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: GRANTEE,
      PLATFORM_OPERATOR_SUBJECTS: `${GRANTOR},${GRANTEE},${OTHER},${DISABLED},${CONFIG_B},${PERM},${RACE}`,
      PLATFORM_OPERATOR_CAPABILITIES: "quota.read,subscription.manage",
    } as never);
  }, 60_000);

  beforeEach(async () => {
    if (!enabled) return;
    setGrantee(GRANTEE);
    await resetFixtures();
  });

  afterAll(async () => {
    for (const db of sessions.splice(0)) await db.close().catch(() => undefined);
    processHandle?.kill();
    if (enabled) overrideEnv(originalEnv as never);
  });

  localTest("047 持久幂等：撤回/过期/重启后同键重放不复活，新授权需当前版本", async () => {
    let now = Date.parse("2026-11-02T09:00:00.000Z");
    const service = makeService(() => now);
    const reader = createPlatformOperatorCapabilityReader(root, service);

    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read"]);

    const first = await service.grant({ actorSubject: GRANTOR, reason: "fork-once", idempotencyKey: "grant-1" });
    expect(first.status).toBe("active");
    expect(await reader.getCapabilities(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);

    const replay = await service.grant({ actorSubject: GRANTOR, reason: "fork-once", idempotencyKey: "grant-1" });
    expect(replay.notAfter).toBe(first.notAfter);
    expect(replay.version).toBe(first.version);

    const revoked = await service.revoke({ actorSubject: GRANTOR, reason: "done", idempotencyKey: "revoke-1" });
    expect(revoked.status).toBe("revoked");
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read"]);

    now += 5 * 60 * 1000;
    const replayAfterRevoke = await service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(replayAfterRevoke.status).toBe("revoked");
    expect(replayAfterRevoke.notAfter).toBe(first.notAfter);

    // 重启（新 service 实例、同一数据库）后同键仍不复活。
    const restarted = makeService(() => now);
    const replayAfterRestart = await restarted.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(replayAfterRestart.status).toBe("revoked");
    expect(replayAfterRestart.notAfter).toBe(first.notAfter);

    await expect(service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-expected-version-required" });
    const regranted = await service.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: revoked.version ?? undefined,
      reason: "regrant",
    });
    expect(regranted.status).toBe("active");
    expect(regranted.version).toBe((revoked.version ?? 0) + 1);

    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    expect(await reader.getCapabilities(GRANTEE)).toEqual(["quota.read"]);
    const replayExpired = await service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2" });
    expect(replayExpired.status).toBe("expired");
    expect(replayExpired.notAfter).toBe(regranted.notAfter);

    await expect(service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-3" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-expected-version-required" });
    const renewed = await service.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-3",
      expectedVersion: regranted.version ?? undefined,
    });
    expect(renewed.status).toBe("active");
    expect(await reader.getCapabilities(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);
  }, 60_000);

  localTest("运营主体禁用/移除后临时能力 fail closed", async () => {
    const now = Date.parse("2026-11-02T09:00:00.000Z");
    setGrantee(DISABLED);
    const service = makeService(() => now);
    const reader = createPlatformOperatorCapabilityReader(root, service);
    await service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-disabled" });
    expect(await reader.getCapabilities(DISABLED)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);

    await root.query(`UPDATE platform_operator:disabled SET status = "disabled";`);
    expect(await service.activeCapabilitiesFor(DISABLED)).toEqual([]);
    expect(await reader.getCapabilities(DISABLED)).toEqual([]);

    await root.query(`UPDATE platform_operator:disabled SET status = "active";`);
    expect(await reader.getCapabilities(DISABLED)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);

    await root.query(`DELETE platform_operator:disabled;`);
    expect(await service.activeCapabilitiesFor(DISABLED)).toEqual([]);
    expect(await reader.getCapabilities(DISABLED)).toEqual([]);
  }, 60_000);

  localTest("grantee 配置变更/清空/重启后旧主体失效，同一时刻只认当前配置", async () => {
    const now = Date.parse("2026-11-02T09:00:00.000Z");
    setGrantee(CONFIG_B);
    const service = makeService(() => now);
    const reader = createPlatformOperatorCapabilityReader(root, service);
    const grant = await service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-config-b" });
    expect(grant.status).toBe("active");
    expect(await reader.getCapabilities(CONFIG_B)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);

    setGrantee(GRANTEE);
    expect(await service.activeCapabilitiesFor(CONFIG_B)).toEqual([]);
    expect(await reader.getCapabilities(CONFIG_B)).toEqual(["quota.read"]);

    const restarted = makeService(() => now);
    expect(await restarted.activeCapabilitiesFor(CONFIG_B)).toEqual([]);

    setGrantee(undefined);
    expect(await restarted.activeCapabilitiesFor(CONFIG_B)).toEqual([]);
    expect(await restarted.activeCapabilitiesFor(GRANTEE)).toEqual([]);
  }, 60_000);

  localTest("无临时行时撤回仍正确投影永久能力；临时撤回不承诺 403", async () => {
    const now = Date.parse("2026-11-02T09:00:00.000Z");
    await root.query(`
      CREATE platform_operator_capability:perm_probe
      SET operator = platform_operator:perm,
          capability = $capability,
          status = "active",
          granted_by_subject = "fixture";
    `, { capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY });
    const service = makeService(() => now);
    setGrantee(PERM);
    const reader = createPlatformOperatorCapabilityReader(root, service);

    const revoked = await service.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-perm" });
    expect(revoked.status).toBe("absent");
    expect(revoked.permanentActive).toBe(true);
    expect(await reader.getCapabilities(PERM)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);

    await service.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-perm" });
    const after = await service.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-perm-2" });
    expect(after.status).toBe("revoked");
    expect(after.permanentActive).toBe(true);
    // 永久能力仍在，探针读面仍包含该能力；不能把临时撤回写成必然 403。
    expect(await service.activeCapabilitiesFor(PERM)).toEqual([]);
    expect(await reader.getCapabilities(PERM)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"]);
  }, 60_000);

  localTest("并发 CAS：撤回后旧授予不能覆盖撤回；反向顺序旧撤回不能覆盖授予", async () => {
    let now = Date.parse("2026-11-02T09:00:00.000Z");
    setGrantee(RACE);
    const realStore = new SurrealTemporaryGrantStore(async () => root, "main");
    const setup = new EndpointProbeTemporaryGrantService(realStore, () => now);
    await setup.grant({ actorSubject: GRANTOR, idempotencyKey: "race-setup" });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;

    // 场景 1：授予已被 barrier 停在写前，撤回先完成；旧授予必须冲突。
    {
      const entered = deferred();
      const release = deferred();
      const gatedStore: TemporaryGrantStore = {
        isActiveOperator: realStore.isActiveOperator.bind(realStore),
        getGrant: realStore.getGrant.bind(realStore),
        getRequest: realStore.getRequest.bind(realStore),
        countPermanent: realStore.countPermanent.bind(realStore),
        recordRequest: realStore.recordRequest.bind(realStore),
        revoke: realStore.revoke.bind(realStore),
        activate: async (input) => {
          entered.resolve();
          await release.promise;
          return realStore.activate(input);
        },
      };
      const grantService = new EndpointProbeTemporaryGrantService(gatedStore, () => now);
      const revokeService = new EndpointProbeTemporaryGrantService(realStore, () => now);
      const grantPromise = grantService.grant({
        actorSubject: GRANTOR,
        idempotencyKey: "race-grant-1",
        expectedVersion: 1,
      });
      await entered.promise;
      const revoked = await revokeService.revoke({
        actorSubject: GRANTOR,
        idempotencyKey: "race-revoke-1",
        expectedVersion: 1,
      });
      expect(revoked.status).toBe("revoked");
      release.resolve();
      await expect(grantPromise).rejects.toMatchObject({
        status: 409,
        code: "endpoint-probe-temporary-grant-version-conflict",
      });
      const final = await setup.getStatusFor(RACE);
      expect(final.status).toBe("revoked");
      expect(final.version).toBe(2);
    }

    // 场景 2：撤回被 barrier 停在写前，授予先完成；旧撤回必须冲突且不覆盖。
    await resetTemporaryRows();
    now = Date.parse("2026-11-02T09:00:00.000Z");
    const setup2 = new EndpointProbeTemporaryGrantService(realStore, () => now);
    await setup2.grant({ actorSubject: GRANTOR, idempotencyKey: "race-setup-2" });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    {
      const entered = deferred();
      const release = deferred();
      const gatedStore: TemporaryGrantStore = {
        isActiveOperator: realStore.isActiveOperator.bind(realStore),
        getGrant: realStore.getGrant.bind(realStore),
        getRequest: realStore.getRequest.bind(realStore),
        countPermanent: realStore.countPermanent.bind(realStore),
        activate: realStore.activate.bind(realStore),
        recordRequest: realStore.recordRequest.bind(realStore),
        revoke: async (input) => {
          entered.resolve();
          await release.promise;
          return realStore.revoke(input);
        },
      };
      const grantService = new EndpointProbeTemporaryGrantService(realStore, () => now);
      const revokeService = new EndpointProbeTemporaryGrantService(gatedStore, () => now);
      const revokePromise = revokeService.revoke({
        actorSubject: GRANTOR,
        idempotencyKey: "race-revoke-2",
        expectedVersion: 1,
      });
      await entered.promise;
      const granted = await grantService.grant({
        actorSubject: GRANTOR,
        idempotencyKey: "race-grant-2",
        expectedVersion: 1,
      });
      expect(granted.status).toBe("active");
      release.resolve();
      await expect(revokePromise).rejects.toMatchObject({
        status: 409,
        code: "endpoint-probe-temporary-grant-version-conflict",
      });
      const final = await setup2.getStatusFor(RACE);
      expect(final.status).toBe("active");
      expect(final.version).toBe(2);
    }

    // 场景 3：同键并发授予只允许一条授权和一条请求记录。
    await resetTemporaryRows();
    now = Date.parse("2026-11-02T09:00:00.000Z");
    const setup3 = new EndpointProbeTemporaryGrantService(realStore, () => now);
    await setup3.grant({ actorSubject: GRANTOR, idempotencyKey: "race-setup-3" });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    {
      let arrivals = 0;
      const bothEntered = deferred();
      const barrier: TemporaryGrantStore = {
        isActiveOperator: realStore.isActiveOperator.bind(realStore),
        getGrant: realStore.getGrant.bind(realStore),
        getRequest: realStore.getRequest.bind(realStore),
        countPermanent: realStore.countPermanent.bind(realStore),
        recordRequest: realStore.recordRequest.bind(realStore),
        revoke: realStore.revoke.bind(realStore),
        activate: async (input) => {
          arrivals += 1;
          if (arrivals === 2) bothEntered.resolve();
          await bothEntered.promise;
          return realStore.activate(input);
        },
      };
      const serviceA = new EndpointProbeTemporaryGrantService(barrier, () => now);
      const serviceB = new EndpointProbeTemporaryGrantService(barrier, () => now);
      const results = await Promise.allSettled([
        serviceA.grant({ actorSubject: GRANTOR, idempotencyKey: "same-key", expectedVersion: 1 }),
        serviceB.grant({ actorSubject: GRANTOR, idempotencyKey: "same-key", expectedVersion: 1 }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length).toBeLessThanOrEqual(2);
      const rows = await root.query(
        `SELECT * FROM platform_operator_temporary_grant WHERE subject = $subject;`,
        { subject: RACE },
      ) as unknown[];
      const grantRows = Array.isArray(rows[0]) ? rows[0] as Array<Record<string, unknown>> : [];
      expect(grantRows).toHaveLength(1);
      expect(grantRows[0]?.version).toBe(2);
      const requests = await root.query(
        `SELECT * FROM platform_operator_temporary_grant_request WHERE subject = $subject AND idempotency_key = "same-key";`,
        { subject: RACE },
      ) as unknown[];
      expect(Array.isArray(requests[0]) ? requests[0] : []).toHaveLength(1);
      if (fulfilled.length === 2) {
        const notAfters = fulfilled.map((result) => (result as PromiseFulfilledResult<{ notAfter: string | null }>).value.notAfter);
        expect(notAfters[0]).toBe(notAfters[1]);
      }
    }
  }, 60_000);

  localTest("seed 不复活临时权限、原永久能力集合不变", async () => {
    const now = Date.parse("2026-11-02T09:00:00.000Z");
    const service = makeService(() => now);
    const reader = createPlatformOperatorCapabilityReader(root, service);
    const first = await service.grant({ actorSubject: GRANTOR, idempotencyKey: "seed-grant" });
    const revoked = await service.revoke({
      actorSubject: GRANTOR,
      idempotencyKey: "seed-revoke",
      expectedVersion: first.version ?? undefined,
    });
    expect(revoked.status).toBe("revoked");
    expect(await service.activeCapabilitiesFor(GRANTEE)).toEqual([]);

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
    expect((await service.getStatusFor(GRANTEE)).permanentActive).toBe(false);
  }, 60_000);

  localTest("round-02：省略 expectedVersion 的撤回不能覆盖期间新授予（真实 fork 屏障）", async () => {
    let now = Date.parse("2026-11-02T09:00:00.000Z");
    setGrantee(RACE);
    const realStore = new SurrealTemporaryGrantStore(async () => root, "main");
    const setup = new EndpointProbeTemporaryGrantService(realStore, () => now);
    await setup.grant({ actorSubject: GRANTOR, idempotencyKey: "noexp-setup" });
    // 行仍是 status=active / version=1，只是已过 not_after。
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;

    const entered = deferred();
    const release = deferred();
    const gatedStore: TemporaryGrantStore = {
      isActiveOperator: realStore.isActiveOperator.bind(realStore),
      getGrant: realStore.getGrant.bind(realStore),
      getRequest: realStore.getRequest.bind(realStore),
      countPermanent: realStore.countPermanent.bind(realStore),
      activate: realStore.activate.bind(realStore),
      recordRequest: realStore.recordRequest.bind(realStore),
      revoke: async (input) => {
        entered.resolve();
        await release.promise;
        return realStore.revoke(input);
      },
    };
    const revokeService = new EndpointProbeTemporaryGrantService(gatedStore, () => now);
    const grantService = new EndpointProbeTemporaryGrantService(realStore, () => now);

    // 无 expectedVersion 的撤回读完 v1 后停在写前。
    const revokePromise = revokeService.revoke({ actorSubject: GRANTOR, idempotencyKey: "noexp-revoke" });
    await entered.promise;

    // 期间一次明确的重新授予（expectedVersion=1）成功生成 v2 新授权。
    const regrant = await grantService.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "noexp-regrant",
      expectedVersion: 1,
    });
    expect(regrant.status).toBe("active");
    expect(regrant.version).toBe(2);

    release.resolve();
    await expect(revokePromise).rejects.toMatchObject({
      status: 409,
      code: "endpoint-probe-temporary-grant-version-conflict",
    });
    const final = await setup.getStatusFor(RACE);
    expect(final.status).toBe("active");
    expect(final.version).toBe(2);
    expect(final.notAfter).toBe(regrant.notAfter);
    expect(await grantService.activeCapabilitiesFor(RACE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
  }, 60_000);

  localTest("round-02：冲突后按已撤回成功返回也必须登记幂等键（真实 fork 屏障）", async () => {
    const now = Date.parse("2026-11-02T09:00:00.000Z");
    setGrantee(RACE);
    const realStore = new SurrealTemporaryGrantStore(async () => root, "main");
    const setup = new EndpointProbeTemporaryGrantService(realStore, () => now);
    const first = await setup.grant({ actorSubject: GRANTOR, idempotencyKey: "idem-setup" });
    expect(first.status).toBe("active");

    const entered = deferred();
    const release = deferred();
    const gatedStore: TemporaryGrantStore = {
      isActiveOperator: realStore.isActiveOperator.bind(realStore),
      getGrant: realStore.getGrant.bind(realStore),
      getRequest: realStore.getRequest.bind(realStore),
      countPermanent: realStore.countPermanent.bind(realStore),
      activate: realStore.activate.bind(realStore),
      recordRequest: realStore.recordRequest.bind(realStore),
      revoke: async (input) => {
        entered.resolve();
        await release.promise;
        return realStore.revoke(input);
      },
    };
    const slowService = new EndpointProbeTemporaryGrantService(gatedStore, () => now);
    const fastService = new EndpointProbeTemporaryGrantService(realStore, () => now);

    // 撤回 A（key=r）读完 v1 后停在写前；撤回 B 先完成，使 A 落入“latest 已撤回”的成功分支。
    const revokeAPromise = slowService.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-r" });
    await entered.promise;
    const revokeB = await fastService.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-b" });
    expect(revokeB.status).toBe("revoked");
    release.resolve();

    const revokeA = await revokeAPromise;
    expect(revokeA.status).toBe("revoked");

    // key=r 必须已持久登记：先断言请求表存在该键，再做重放演练。
    const recorded = await root.query(
      `SELECT * FROM platform_operator_temporary_grant_request WHERE subject = $subject AND idempotency_key = "revoke-r";`,
      { subject: RACE },
    ) as unknown[];
    expect(Array.isArray(recorded[0]) ? recorded[0] : []).toHaveLength(1);

    const regrant = await fastService.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-after",
      expectedVersion: revokeB.version ?? undefined,
    });
    expect(regrant.status).toBe("active");
    expect(await fastService.activeCapabilitiesFor(RACE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);

    // 重放旧请求 A：只能返回当前状态，不能撤回这次新授权。
    const replay = await fastService.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-r" });
    expect(replay.status).toBe("active");
    expect(await fastService.activeCapabilitiesFor(RACE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    const rows = await root.query(
      `SELECT * FROM platform_operator_temporary_grant WHERE subject = $subject;`,
      { subject: RACE },
    ) as unknown[];
    const grantRows = Array.isArray(rows[0]) ? rows[0] as Array<Record<string, unknown>> : [];
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]?.status).toBe("active");
    expect(grantRows[0]?.version).toBe(regrant.version);
  }, 60_000);
});
