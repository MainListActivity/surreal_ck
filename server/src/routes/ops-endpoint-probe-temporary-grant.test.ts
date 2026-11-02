import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { env, overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import {
  createPlatformOperatorCapabilityReader,
  requirePlatformOperator,
  type PlatformOperatorCapabilityReader,
} from "../ops/operator-auth";
import {
  ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
  ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS,
  EndpointProbeTemporaryGrantService,
} from "../ops/endpoint-probe-temporary-grant";
import { createOpsEndpointProbeTemporaryGrantRoutes } from "./ops-endpoint-probe-temporary-grant";
import { createOpsInternalAiRoutes } from "./ops-internal-ai";
import { InternalAiGate } from "../internal-ai/gate";
import { InternalAiStore } from "../internal-ai/store";
import { createEndpointProbeLimiter, runEndpointProbe } from "../internal-ai/endpoint-probe";
import { FakeTemporaryGrantStore } from "../../test/fake-temporary-grant-store";

const issuer = "http://127.0.0.1:18094/issuer";
const opsAudience = "https://ops-temp-grant.example.test/mcp";
const clientAudience = "https://auth-temp-grant.example.test";
const GRANTOR = "grantor-subject";
const GRANTEE = "grantee-subject";
const OTHER = "other-operator";

let privateKey: CryptoKey;
let jwksServer: ReturnType<typeof Bun.serve>;
let originalEnv: Record<string, unknown>;
let baseEnv: Record<string, unknown>;

const signed = (subject: string): Promise<string> =>
  new SignJWT({ email: `${subject}@example.test` })
    .setProtectedHeader({ alg: "RS256", kid: "temp-grant-key" })
    .setIssuer(issuer).setAudience(opsAudience).setSubject(subject).setExpirationTime("5m")
    .sign(privateKey);

class MemoryOperatorDb {
  readonly operators = new Map<string, { id: string; status: "active" | "disabled"; kind: "human" | "agent" }>();
  readonly capabilities = new Map<string, Set<string>>();

  seed(subject: string, capabilities: readonly string[]): void {
    this.operators.set(subject, { id: `platform_operator:${this.operators.size + 1}`, status: "active", kind: "human" });
    this.capabilities.set(subject, new Set(capabilities));
  }

  setStatus(subject: string, status: "active" | "disabled"): void {
    const row = this.operators.get(subject);
    if (row) this.operators.set(subject, { ...row, status });
  }

  remove(subject: string): void {
    this.operators.delete(subject);
    this.capabilities.delete(subject);
  }

  async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const text = sql.replace(/\s+/g, " ");
    const subject = String(params.subject);
    if (text.includes("SELECT kind FROM platform_operator")) {
      const row = this.operators.get(subject);
      return [row && row.status === "active" ? [{ kind: row.kind }] : []];
    }
    if (text.includes("SELECT VALUE capability FROM platform_operator_capability")) {
      const row = this.operators.get(subject);
      if (!row || row.status !== "active") return [[]];
      return [[...(this.capabilities.get(subject) ?? [])]];
    }
    throw new Error(`unexpected operator sql: ${text}`);
  }
}

function makeStore(): FakeTemporaryGrantStore {
  const store = new FakeTemporaryGrantStore();
  for (const subject of [GRANTOR, GRANTEE, OTHER]) store.seedOperator(subject);
  return store;
}

function makeOperatorDb(): MemoryOperatorDb {
  const db = new MemoryOperatorDb();
  for (const subject of [GRANTOR, GRANTEE, OTHER]) db.seed(subject, ["quota.read"]);
  return db;
}

function grantApp(store: FakeTemporaryGrantStore, now: () => number) {
  const service = new EndpointProbeTemporaryGrantService(store, now);
  const reader: PlatformOperatorCapabilityReader = {
    async getCapabilities(subject) {
      return subject === GRANTOR || subject === GRANTEE || subject === OTHER ? ["quota.read"] : [];
    },
  };
  const auth = (capability: string) => requirePlatformOperator(capability as never, {
    reader,
    tokenActivityChecker: async () => true,
  });
  return new Hono<AppBindings>()
    .route("/", createOpsEndpointProbeTemporaryGrantRoutes({
      service,
      requireManager: () => auth("quota.read"),
      requireReader: () => auth("quota.read"),
    }))
    .onError(handleError);
}

function probeApp(
  reader: PlatformOperatorCapabilityReader,
  enabled: boolean,
) {
  const neverGate = new InternalAiGate(new InternalAiStore(async () => { throw new Error("no store"); }));
  const probeAuth = requirePlatformOperator(ENDPOINT_PROBE_TEMPORARY_CAPABILITY, {
    reader,
    tokenActivityChecker: async () => true,
  });
  return new Hono<AppBindings>()
    .route("/", createOpsInternalAiRoutes({
      gate: neverGate,
      runtime: {},
      requireProbeOperator: probeAuth,
      endpointProbe: enabled
        ? {
            enabled: true,
            limiter: createEndpointProbeLimiter({ minIntervalMs: 0 }),
            run: () => runEndpointProbe({
              apiKey: "synthetic",
              fetchImpl: (async () => Response.json({ data: [{ id: "group/work" }] })) as unknown as typeof fetch,
              requestId: () => "req-temp",
            }),
          }
        : { enabled: false },
    }))
    .onError(handleError);
}

function liveApp(store: FakeTemporaryGrantStore, operatorDb: MemoryOperatorDb, now: () => number) {
  const service = new EndpointProbeTemporaryGrantService(store, now);
  const reader = createPlatformOperatorCapabilityReader(operatorDb, service);
  const auth = (capability: string) => requirePlatformOperator(capability as never, {
    reader,
    tokenActivityChecker: async () => true,
  });
  return new Hono<AppBindings>()
    .route("/", createOpsEndpointProbeTemporaryGrantRoutes({
      service,
      requireManager: () => auth("quota.read"),
      requireReader: () => auth("quota.read"),
    }))
    .route("/", createOpsInternalAiRoutes({
      gate: new InternalAiGate(new InternalAiStore(async () => { throw new Error("no store"); })),
      runtime: {},
      requireProbeOperator: auth(ENDPOINT_PROBE_TEMPORARY_CAPABILITY),
      endpointProbe: {
        enabled: true,
        limiter: createEndpointProbeLimiter({ minIntervalMs: 0 }),
        run: () => runEndpointProbe({
          apiKey: "synthetic",
          fetchImpl: (async () => Response.json({ data: [{ id: "group/work" }] })) as unknown as typeof fetch,
          requestId: () => "req-temp",
        }),
      },
    }))
    .onError(handleError);
}

function grantRequest(app: Hono<AppBindings>, token: string, body: Record<string, unknown>) {
  return app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function revokeRequest(app: Hono<AppBindings>, token: string, body: Record<string, unknown>) {
  return app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function probeRequest(app: Hono<AppBindings>, token: string) {
  return app.request("/api/ops/internal-ai/endpoint-probe", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("ops endpoint probe temporary grant routes", () => {
  beforeAll(async () => {
    originalEnv = { ...env };
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    const publicJwk: JWK = { ...(await exportJWK(keyPair.publicKey)), kid: "temp-grant-key", alg: "RS256", use: "sig" };
    jwksServer = Bun.serve({
      port: 18094,
      fetch: (request) => new URL(request.url).pathname === "/jwks" ? Response.json({ keys: [publicJwk] }) : new Response("not found", { status: 404 }),
    });
    overrideEnv({
      NODE_ENV: "test",
      OIDC_ISSUER: issuer,
      OIDC_JWKS_URL: "http://127.0.0.1:18094/jwks",
      OIDC_AUDIENCE: clientAudience,
      OIDC_OPS_AUDIENCE: opsAudience,
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: GRANTEE,
      INTERNAL_AI_ENDPOINT_PROBE_ENABLED: "0",
    } as never);
    baseEnv = { ...env };
  });

  afterEach(() => {
    overrideEnv(baseEnv as never);
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv as never);
  });

  test("授予仅 grantor 可做；缺少 idempotencyKey 400；状态脱敏且含永久能力标记", async () => {
    const store = makeStore();
    store.seedPermanent(GRANTEE, ["quota.read"]);
    const app = grantApp(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const denied = await grantRequest(app, await signed(OTHER), { reason: "nope", idempotencyKey: "nope" });
    expect(denied.status).toBe(403);

    const missingKey = await grantRequest(app, await signed(GRANTOR), { reason: "no-key" });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error: { code: "endpoint-probe-temporary-grant-body-invalid" } });

    const granted = await grantRequest(app, await signed(GRANTOR), { reason: "fv06", idempotencyKey: "grant-1" });
    expect(granted.status).toBe(200);
    const body = await granted.json() as Record<string, unknown>;
    expect(body.status).toBe("active");
    expect(body.capability).toBe(ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
    expect(String(body.subjectHash)).toStartWith("sha256:");
    expect(JSON.stringify(body)).not.toContain(GRANTEE);
    expect(body.permanentActive).toBe(false);

    const status = await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
      method: "GET",
      headers: { authorization: `Bearer ${await signed(GRANTOR)}` },
    });
    expect(status.status).toBe(200);
  });

  test("撤回后同键重放不复活（HTTP）", async () => {
    const store = makeStore();
    const app = grantApp(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const granted = await grantRequest(app, await signed(GRANTOR), { idempotencyKey: "grant-1" });
    const grantedBody = await granted.json() as Record<string, unknown>;
    const revoked = await revokeRequest(app, await signed(GRANTOR), { idempotencyKey: "revoke-1", reason: "done" });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as Record<string, unknown>).status).toBe("revoked");

    const replay = await grantRequest(app, await signed(GRANTOR), { idempotencyKey: "grant-1" });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as Record<string, unknown>;
    expect(replayBody.status).toBe("revoked");
    expect(replayBody.notAfter).toBe(grantedBody.notAfter);
    expect(store.getGrantRow(GRANTEE)?.status).toBe("revoked");
  });

  test("撤回与到期后，探针路由对旧会话立即 403；默认关闭仍 503", async () => {
    const store = makeStore();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const temporary = new EndpointProbeTemporaryGrantService(store, () => now);
    await temporary.grant({ actorSubject: GRANTOR, idempotencyKey: "grant-1" });

    const liveReader: PlatformOperatorCapabilityReader = {
      async getCapabilities(subject) {
        const permanent = subject === GRANTEE || subject === GRANTOR ? ["quota.read"] as const : [];
        const temp = await temporary.activeCapabilitiesFor(subject);
        return [...new Set([...permanent, ...temp])].sort() as never;
      },
    };

    const disabled = probeApp(liveReader, false);
    expect((await probeRequest(disabled, await signed(GRANTEE))).status).toBe(503);

    const enabled = probeApp(liveReader, true);
    expect((await probeRequest(enabled, await signed(GRANTEE))).status).toBe(200);

    const revoked = await temporary.revoke({ actorSubject: GRANTOR, reason: "done", idempotencyKey: "revoke-1" });
    const afterRevoke = await probeRequest(enabled, await signed(GRANTEE));
    expect(afterRevoke.status).toBe(403);
    expect(await afterRevoke.json()).toMatchObject({ error: { code: "platform-operator-capability-missing" } });

    await temporary.grant({
      actorSubject: GRANTOR,
      idempotencyKey: "grant-2",
      expectedVersion: revoked.version ?? undefined,
    });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    expect((await probeRequest(enabled, await signed(GRANTEE))).status).toBe(403);
  });

  test("禁用/移除运营主体后，同一旧 token 立即被拒", async () => {
    const store = makeStore();
    const operatorDb = makeOperatorDb();
    const app = liveApp(store, operatorDb, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const granted = await grantRequest(app, await signed(GRANTOR), { idempotencyKey: "grant-1" });
    expect(granted.status).toBe(200);

    // 只签一次 token，禁用/移除后继续复用同一 token。
    const token = await signed(GRANTEE);
    expect((await probeRequest(app, token)).status).toBe(200);

    operatorDb.setStatus(GRANTEE, "disabled");
    store.disableOperator(GRANTEE);
    const disabled = await probeRequest(app, token);
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ error: { code: "platform-operator-inactive" } });

    operatorDb.setStatus(GRANTEE, "active");
    store.seedOperator(GRANTEE);
    expect((await probeRequest(app, token)).status).toBe(200);

    operatorDb.remove(GRANTEE);
    store.disableOperator(GRANTEE);
    const removed = await probeRequest(app, token);
    expect(removed.status).toBe(403);
    expect(await removed.json()).toMatchObject({ error: { code: "platform-operator-inactive" } });
  });

  test("grantee 配置改为 B 后 A 立即失效；同一时刻只认当前配置", async () => {
    const store = makeStore();
    const operatorDb = makeOperatorDb();
    const app = liveApp(store, operatorDb, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const tokenA = await signed(GRANTEE);
    const tokenB = await signed(OTHER);
    expect((await grantRequest(app, await signed(GRANTOR), { idempotencyKey: "grant-a" })).status).toBe(200);
    expect((await probeRequest(app, tokenA)).status).toBe(200);

    overrideEnv({ ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: OTHER } as never);
    const afterChange = await probeRequest(app, tokenA);
    expect(afterChange.status).toBe(403);
    expect(await afterChange.json()).toMatchObject({ error: { code: "platform-operator-capability-missing" } });
    expect((await probeRequest(app, tokenB)).status).toBe(403);

    expect((await grantRequest(app, await signed(GRANTOR), { idempotencyKey: "grant-b" })).status).toBe(200);
    expect((await probeRequest(app, tokenB)).status).toBe(200);
    expect((await probeRequest(app, tokenA)).status).toBe(403);

    const statusByA = await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
      method: "GET",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(statusByA.status).toBe(403);

    // 清空配置后 B 也不再有效。
    overrideEnv({ ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: undefined } as never);
    expect((await probeRequest(app, tokenB)).status).toBe(403);
  });

  test("存在永久能力时，临时撤回不承诺 403 且 permanentActive=true", async () => {
    const store = makeStore();
    const operatorDb = makeOperatorDb();
    operatorDb.seed(GRANTEE, ["quota.read", ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    store.seedPermanent(GRANTEE, ["quota.read", ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    const app = liveApp(store, operatorDb, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const token = await signed(GRANTEE);
    expect((await probeRequest(app, token)).status).toBe(200);

    const revoked = await revokeRequest(app, await signed(GRANTOR), { idempotencyKey: "revoke-none" });
    expect(revoked.status).toBe(200);
    const body = await revoked.json() as Record<string, unknown>;
    expect(body.status).toBe("absent");
    expect(body.permanentActive).toBe(true);

    // 永久能力仍在，探针仍可通过；不得把这次撤回写成必然 403。
    expect((await probeRequest(app, token)).status).toBe(200);
  });

  test("审计不含原始 subject；其它主体不能读状态", async () => {
    const store = makeStore();
    const app = grantApp(store, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await grantRequest(app, await signed(GRANTOR), { reason: "audit", idempotencyKey: "audit-1" });
      const denied = await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
        method: "GET",
        headers: { authorization: `Bearer ${await signed(OTHER)}` },
      });
      expect(denied.status).toBe(403);
      const dump = JSON.stringify(info.mock.calls);
      expect(dump).toContain("endpoint-probe-temporary-grant.grant");
      expect(dump).not.toContain(GRANTEE);
      expect(dump).not.toContain(GRANTOR);
    } finally {
      info.mockRestore();
    }
  });
});
