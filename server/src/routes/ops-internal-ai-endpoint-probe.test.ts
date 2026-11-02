import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { requirePlatformOperator, type PlatformOperatorCapabilityReader } from "../ops/operator-auth";
import { createOpsInternalAiRoutes } from "./ops-internal-ai";
import { InternalAiGate } from "../internal-ai/gate";
import { InternalAiStore } from "../internal-ai/store";
import { createEndpointProbeLimiter, runEndpointProbe, type EndpointProbeResult } from "../internal-ai/endpoint-probe";

const issuer = "http://127.0.0.1:18093/issuer";
const opsAudience = "https://ops-probe.example.test/mcp";
const clientAudience = "https://auth-probe.example.test";

let privateKey: CryptoKey;
let jwksServer: ReturnType<typeof Bun.serve>;
let originalEnv: Record<string, unknown>;

const neverGate = new InternalAiGate(new InternalAiStore(async () => { throw new Error("must not reach store"); }));

const signed = (): Promise<string> =>
  new SignJWT({ email: "operator@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "probe-key" })
    .setIssuer(issuer).setAudience(opsAudience).setSubject("operator:probe").setExpirationTime("5m")
    .sign(privateKey);

type ProbeOptions = Readonly<{
  capabilities: string[];
  enabled?: boolean;
  limiter?: ReturnType<typeof createEndpointProbeLimiter>;
  run?: () => Promise<EndpointProbeResult>;
}>;

function appWith(options: ProbeOptions): Hono<AppBindings> {
  const reader: PlatformOperatorCapabilityReader = {
    async getCapabilities() { return options.capabilities as never; },
  };
  const probeAuth = requirePlatformOperator("internal-ai.endpoint-probe", { reader, tokenActivityChecker: async () => true });
  const endpointProbe = options.enabled === undefined && !options.limiter && !options.run
    ? undefined
    : { enabled: options.enabled ?? true, limiter: options.limiter, run: options.run };
  return new Hono<AppBindings>()
    .route("/", createOpsInternalAiRoutes({ gate: neverGate, runtime: {}, requireProbeOperator: probeAuth, endpointProbe }))
    .onError(handleError);
}

const call = (app: Hono<AppBindings>, init: RequestInit = {}) => app.request("/api/ops/internal-ai/endpoint-probe", { method: "POST", ...init });
const authHeader = async () => ({ authorization: `Bearer ${await signed()}` });

describe("ops endpoint probe route", () => {
  beforeAll(async () => {
    const { env } = await import("../env");
    originalEnv = { ...env };
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    const publicJwk: JWK = { ...(await exportJWK(keyPair.publicKey)), kid: "probe-key", alg: "RS256", use: "sig" };
    jwksServer = Bun.serve({
      port: 18093,
      fetch: (request) => new URL(request.url).pathname === "/jwks" ? Response.json({ keys: [publicJwk] }) : new Response("not found", { status: 404 }),
    });
    overrideEnv({ NODE_ENV: "test", OIDC_ISSUER: issuer, OIDC_JWKS_URL: `http://127.0.0.1:18093/jwks`, OIDC_AUDIENCE: clientAudience, OIDC_OPS_AUDIENCE: opsAudience } as never);
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv as never);
  });

  afterEach(() => {
    // 每个用例独立限流窗口，避免互相干扰。
  });

  test("无会话 401，缺专用能力 403", async () => {
    expect((await call(appWith({ capabilities: [] }))).status).toBe(401);

    const wrongAudience = await call(appWith({ capabilities: ["internal-ai.endpoint-probe"] }), {
      headers: { authorization: `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "probe-key" }).setIssuer(issuer).setAudience(clientAudience).setSubject("operator:probe").setExpirationTime("5m").sign(privateKey)}` },
    });
    expect(wrongAudience.status).toBe(401);

    const noCapability = await call(appWith({ capabilities: ["quota.read"] }), { headers: await authHeader() });
    expect(noCapability.status).toBe(403);
    expect(await noCapability.json()).toMatchObject({ error: { code: "platform-operator-capability-missing" } });
  });

  test("默认关闭：具备能力也不执行探针", async () => {
    const app = appWith({ capabilities: ["internal-ai.endpoint-probe"] });
    const response = await call(app, { headers: await authHeader() });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "internal-ai-endpoint-probe-disabled" } });
  });

  test("开启后只返回受控字段，且审计不含凭证", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const mock = (async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://data.maplayer.top/ofm/v1/models");
        return Response.json({ data: [{ id: "group/work" }] });
      }) as unknown as typeof fetch;
      const app = appWith({
        capabilities: ["internal-ai.endpoint-probe"],
        limiter: createEndpointProbeLimiter({ minIntervalMs: 0 }),
        run: () => runEndpointProbe({ apiKey: "synthetic-probe-key", fetchImpl: mock, requestId: () => "req-route" }),
      });
      const response = await call(app, { headers: await authHeader() });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["checkedAt", "endpointHost", "endpointPath", "errorType", "latencyMs", "requestId", "status"]);
      expect(body).toMatchObject({ endpointHost: "data.maplayer.top", endpointPath: "/ofm/v1", status: "catalog-readable", errorType: null, requestId: "req-route" });
      expect(JSON.stringify(body)).not.toContain("synthetic-probe-key");

      const audit = info.mock.calls.filter(entry => entry[0] === "[ops-audit] internal-ai.endpoint-probe");
      expect(audit).toHaveLength(1);
      const line = JSON.stringify(audit[0]![1]);
      expect(line).toContain("operator:probe");
      expect(line).not.toContain("synthetic-probe-key");
      expect(line).not.toContain("authorization");
    } finally {
      info.mockRestore();
    }
  });

  test("拒绝任何查询串或请求体（不接受调用方 URL/key/模型）", async () => {
    const app = appWith({ capabilities: ["internal-ai.endpoint-probe"], enabled: true, limiter: createEndpointProbeLimiter({ minIntervalMs: 0 }), run: async () => { throw new Error("must not run"); } });
    const headers = await authHeader();
    const withQuery = await app.request("/api/ops/internal-ai/endpoint-probe?url=https%3A%2F%2Fevil.example&host=x", { method: "POST", headers });
    expect(withQuery.status).toBe(400);
    expect(await withQuery.json()).toMatchObject({ error: { code: "internal-ai-endpoint-probe-input-rejected" } });

    const withBody = await call(app, { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ url: "https://evil.example", apiKey: "x", model: "group/work" }) });
    expect(withBody.status).toBe(400);
    expect(await withBody.json()).toMatchObject({ error: { code: "internal-ai-endpoint-probe-input-rejected" } });
  });

  test("并发与冷却都由限流挡住", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const app = appWith({
      capabilities: ["internal-ai.endpoint-probe"],
      limiter: createEndpointProbeLimiter({ maxConcurrent: 1, minIntervalMs: 60_000 }),
      run: async () => { await gate; return { endpointHost: "data.maplayer.top", endpointPath: "/ofm/v1", checkedAt: new Date(0).toISOString(), status: "catalog-readable", errorType: null, latencyMs: 1, requestId: "req-concurrent" }; },
    });
    const headers = await authHeader();
    const first = call(app, { headers });
    const second = await call(app, { headers });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: "internal-ai-endpoint-probe-busy" } });
    release();
    expect((await first).status).toBe(200);

    const throttled = await call(app, { headers });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ error: { code: "internal-ai-endpoint-probe-throttled" } });
  });
});
