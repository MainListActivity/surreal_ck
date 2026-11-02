import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { env, overrideEnv } from "../env";
import { FakeTemporaryGrantStore } from "../../test/fake-temporary-grant-store";
import {
  ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
  ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS,
  EndpointProbeTemporaryGrantService,
  mergeTemporaryCapabilities,
  type TemporaryGrantRevokeInput,
  type TemporaryGrantStore,
} from "./endpoint-probe-temporary-grant";

const GRANTOR = "grantor-subject";
const GRANTEE = "grantee-subject";
const OTHER = "other-subject";

let originalEnv: Record<string, unknown> = {};

function configure(grantee: string | undefined): void {
  overrideEnv({
    ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
    ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: grantee ?? "",
  } as never);
}

function makeStore(): FakeTemporaryGrantStore {
  const store = new FakeTemporaryGrantStore();
  for (const subject of [GRANTOR, GRANTEE, OTHER]) store.seedOperator(subject);
  return store;
}

function service(store: FakeTemporaryGrantStore, now: () => number) {
  return new EndpointProbeTemporaryGrantService(store, now);
}

describe("endpoint probe temporary grant service", () => {
  beforeAll(() => {
    originalEnv = { ...env };
  });

  afterEach(() => {
    configure(GRANTEE);
  });

  afterAll(() => {
    overrideEnv(originalEnv as never);
  });

  test("mergeTemporaryCapabilities 去重并排序，不删除永久能力", () => {
    expect(mergeTemporaryCapabilities(
      ["quota.read", "subscription.manage"],
      [ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"],
    )).toEqual(["internal-ai.endpoint-probe", "quota.read", "subscription.manage"]);
  });

  test("单主体授予后有效；同键重放与新键都不续期", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);

    const first = await svc.grant({ actorSubject: GRANTOR, reason: "fv06-once", idempotencyKey: "grant-1" });
    expect(first.status).toBe("active");
    expect(first.notAfter).toBe(new Date(now + ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS).toISOString());
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    expect(await svc.activeCapabilitiesFor(OTHER)).toEqual([]);

    now += 10 * 60 * 1000;
    const replay = await svc.grant({ actorSubject: GRANTOR, reason: "fv06-once", idempotencyKey: "grant-1" });
    expect(replay.notAfter).toBe(first.notAfter);
    expect(replay.version).toBe(first.version);

    const newKey = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2" });
    expect(newKey.notAfter).toBe(first.notAfter);
    expect(newKey.version).toBe(first.version);
    expect(store.getGrantRow(GRANTEE)?.not_after.toISOString()).toBe(first.notAfter!);
  });

  test("授予缺少 idempotencyKey 拒绝", async () => {
    const svc = service(makeStore(), () => Date.parse("2026-11-02T08:00:00.000Z"));
    await expect(svc.grant({ actorSubject: GRANTOR })).rejects.toMatchObject({
      status: 400,
      code: "endpoint-probe-temporary-grant-idempotency-required",
    });
  });

  test("撤回后同键重放不复活；重新授予需要新键和当前版本", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    const granted = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    const revoked = await svc.revoke({ actorSubject: GRANTOR, reason: "done", idempotencyKey: "revoke-1" });
    expect(revoked.status).toBe("revoked");
    expect(revoked.version).toBe((granted.version ?? 0) + 1);

    now += 5 * 60 * 1000;
    const replayGrant = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(replayGrant.status).toBe("revoked");
    expect(replayGrant.notAfter).toBe(granted.notAfter);
    expect(store.getGrantRow(GRANTEE)?.status).toBe("revoked");

    const replayRevoke = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-1" });
    expect(replayRevoke.status).toBe("revoked");

    await expect(svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-expected-version-required" });
    await expect(svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2", expectedVersion: 99 }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-version-conflict" });

    const regranted = await svc.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: revoked.version ?? undefined,
      reason: "regrant",
    });
    expect(regranted.status).toBe("active");
    expect(regranted.version).toBe((revoked.version ?? 0) + 1);
    expect(regranted.notAfter).not.toBe(granted.notAfter);

    // 旧键重放只返回当前 active 状态，不重置 notAfter。
    now += 10 * 60 * 1000;
    const oldKeyReplay = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(oldKeyReplay.status).toBe("active");
    expect(oldKeyReplay.notAfter).toBe(regranted.notAfter);
  });

  test("到期后同键重放不复活；新授权需要当前版本", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    const granted = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });

    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    expect((await svc.getStatusFor(GRANTEE)).status).toBe("expired");

    const replay = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(replay.status).toBe("expired");
    expect(replay.notAfter).toBe(granted.notAfter);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);

    await expect(svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-2" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-expected-version-required" });

    const renewed = await svc.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: granted.version ?? undefined,
    });
    expect(renewed.status).toBe("active");
    expect(renewed.notAfter).toBe(new Date(now + ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS).toISOString());
  });

  test("运营主体被禁用/移除后临时能力 fail closed", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);

    store.disableOperator(GRANTEE);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);

    store.seedOperator(GRANTEE);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);

    store.disableOperator(GRANTEE);
    now += 1;
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
  });

  test("grantee 配置变更/清空/重启后旧主体不生效，且同一时刻只认当前配置", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-a" });
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);

    configure(OTHER);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    expect(await svc.activeCapabilitiesFor(OTHER)).toEqual([]);

    const grantedOther = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-b" });
    expect(grantedOther.status).toBe("active");
    expect(await svc.activeCapabilitiesFor(OTHER)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);

    // 模拟重启：新 service 实例、同一持久存储、配置仍为 OTHER。
    const restarted = service(store, () => now);
    expect(await restarted.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    expect(await restarted.activeCapabilitiesFor(OTHER)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);

    configure(undefined);
    expect(await restarted.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    expect(await restarted.activeCapabilitiesFor(OTHER)).toEqual([]);
  });

  test("无临时行时撤回仍正确报告永久能力", async () => {
    const store = makeStore();
    store.seedPermanent(GRANTEE, [ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    const svc = service(store, () => Date.parse("2026-11-02T08:00:00.000Z"));

    const revoked = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-none" });
    expect(revoked.status).toBe("absent");
    expect(revoked.permanentActive).toBe(true);

    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    const after = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-1" });
    expect(after.status).toBe("revoked");
    expect(after.permanentActive).toBe(true);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    // 永久能力仍在，合并读面不应因临时撤回而移除它。
    expect(mergeTemporaryCapabilities(
      [ENDPOINT_PROBE_TEMPORARY_CAPABILITY],
      await svc.activeCapabilitiesFor(GRANTEE),
    )).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
  });

  test("同一 idempotencyKey 不能跨 grant/revoke 复用", async () => {
    const store = makeStore();
    const svc = service(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "same-key" });
    await expect(svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "same-key" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-idempotency-conflict" });
  });

  test("并发同键授予只产生一条授权且不重复延长", async () => {
    const store = makeStore();
    const now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);

    const [left, right] = await Promise.all([
      svc.grant({ actorSubject: GRANTOR, idempotencyKey: "concurrent" }),
      svc.grant({ actorSubject: GRANTOR, idempotencyKey: "concurrent" }),
    ]);
    expect(store.grants.size).toBe(1);
    expect(store.requests.size).toBe(1);
    expect(store.getGrantRow(GRANTEE)?.version).toBe(1);
    expect(left.notAfter).toBe(right.notAfter);
  });

  test("越权授予与自授拒绝；未配置时 503", async () => {
    const store = makeStore();
    const svc = service(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await expect(svc.grant({ actorSubject: "stranger", idempotencyKey: "k" }))
      .rejects.toMatchObject({ status: 403, code: "endpoint-probe-temporary-grant-forbidden" });

    configure(GRANTOR);
    const misconfigured = service(store, () => Date.now());
    await expect(misconfigured.grant({ actorSubject: GRANTOR, idempotencyKey: "k" }))
      .rejects.toMatchObject({ status: 503, code: "endpoint-probe-temporary-grant-misconfigured" });

    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: undefined,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: undefined,
    } as never);
    const missing = service(store, () => Date.now());
    await expect(missing.grant({ actorSubject: GRANTOR, idempotencyKey: "k" }))
      .rejects.toMatchObject({ status: 503, code: "endpoint-probe-temporary-grant-not-configured" });
  });

  test("版本冲突保护：expectedVersion 不匹配则 409", async () => {
    const store = makeStore();
    const svc = service(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    await expect(svc.revoke({ actorSubject: GRANTOR, expectedVersion: 99, idempotencyKey: "revoke-1" }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-version-conflict" });
  });

  test("省略 expectedVersion 的撤回仍以观测版本做 CAS", async () => {
    const store = makeStore();
    const now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });

    const calls: TemporaryGrantRevokeInput[] = [];
    const spyStore: TemporaryGrantStore = {
      isActiveOperator: store.isActiveOperator.bind(store),
      getGrant: store.getGrant.bind(store),
      getRequest: store.getRequest.bind(store),
      countPermanent: store.countPermanent.bind(store),
      activate: store.activate.bind(store),
      recordRequest: store.recordRequest.bind(store),
      revoke: async (input) => {
        calls.push(input);
        return store.revoke(input);
      },
    };
    const revoked = await service(spyStore, () => now).revoke({
      actorSubject: GRANTOR,
      idempotencyKey: "revoke-1",
    });
    expect(revoked.status).toBe("revoked");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(1);
    expect(calls[0]?.nextVersion).toBe(2);
  });

  test("已撤回且版本不匹配的带键撤回也会登记幂等键，重放不撤回新授权", async () => {
    const store = makeStore();
    const now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(store, () => now);
    const first = await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    const revoked = await svc.revoke({
      actorSubject: GRANTOR,
      idempotencyKey: "revoke-1",
      expectedVersion: first.version ?? undefined,
    });
    expect(revoked.status).toBe("revoked");

    const stale = await svc.revoke({
      actorSubject: GRANTOR,
      idempotencyKey: "revoke-stale",
      expectedVersion: first.version ?? undefined,
    });
    expect(stale.status).toBe("revoked");
    expect([...store.requests.values()].some((row) => row.idempotency_key === "revoke-stale")).toBe(true);

    const regrant = await svc.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: revoked.version ?? undefined,
    });
    expect(regrant.status).toBe("active");
    const versionBefore = store.getGrantRow(GRANTEE)?.version;

    const replay = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-stale" });
    expect(replay.status).toBe("active");
    expect(store.getGrantRow(GRANTEE)?.status).toBe("active");
    expect(store.getGrantRow(GRANTEE)?.version).toBe(versionBefore);
  });

  test("撤回成功后重放同键不撤回后续新授权", async () => {
    const store = makeStore();
    const svc = service(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await svc.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });
    const revoked = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-1" });
    expect(revoked.status).toBe("revoked");

    const regrant = await svc.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: revoked.version ?? undefined,
    });
    expect(regrant.status).toBe("active");

    const replay = await svc.revoke({ actorSubject: GRANTOR, idempotencyKey: "revoke-1" });
    expect(replay.status).toBe("active");
    expect(store.getGrantRow(GRANTEE)?.status).toBe("active");
    expect(store.getGrantRow(GRANTEE)?.version).toBe(regrant.version);
  });
});
