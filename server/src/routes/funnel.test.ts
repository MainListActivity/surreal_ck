import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { requirePlatformOperator, type PlatformOperatorCapabilityReader } from "../ops/operator-auth";
import type { FunnelAggregate } from "../funnel/summary";
import type { FunnelCountStore, FunnelSummaryQuery } from "../funnel/store";
import { createFunnelRoutes } from "./funnel";

const issuer = "http://127.0.0.1:18097/issuer";
const opsAudience = "https://ops-funnel.example.test/mcp";
const clientAudience = "https://auth-funnel.example.test";

let privateKey: CryptoKey;
let jwksServer: ReturnType<typeof Bun.serve>;
let originalEnv: Record<string, unknown>;

const signed = (): Promise<string> =>
  new SignJWT({ email: "operator@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "funnel-key" })
    .setIssuer(issuer).setAudience(opsAudience).setSubject("operator:funnel").setExpirationTime("5m")
    .sign(privateKey);

type AppOptions = Readonly<{
  capabilities: string[];
  summary?: (query: FunnelSummaryQuery) => Promise<FunnelAggregate>;
  list?: FunnelCountStore["list"];
}>;

function appWith(options: AppOptions): Hono<AppBindings> {
  const reader: PlatformOperatorCapabilityReader = {
    async getCapabilities() { return options.capabilities as never; },
  };
  const auth = requirePlatformOperator("funnel.read", {
    reader,
    tokenActivityChecker: async () => true,
  });
  return new Hono<AppBindings>()
    .route("/", createFunnelRoutes({
      requireOperator: () => auth,
      summaryStore: { summarize: options.summary ?? (async () => ({ totalCount: 0, workspaceCount: 0 })) },
      store: { list: options.list ?? (async () => []) },
    }))
    .onError(handleError);
}

const summaryUrl = (params: string) => `/api/ops/funnel-summary?${params}`;
const authHeader = async () => ({ authorization: `Bearer ${await signed()}` });

describe("funnel routes", () => {
  beforeAll(async () => {
    const { env } = await import("../env");
    originalEnv = { ...env };
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    const publicJwk: JWK = { ...(await exportJWK(keyPair.publicKey)), kid: "funnel-key", alg: "RS256", use: "sig" };
    jwksServer = Bun.serve({
      port: 18097,
      fetch: (request) => new URL(request.url).pathname === "/jwks"
        ? Response.json({ keys: [publicJwk] })
        : new Response("not found", { status: 404 }),
    });
    overrideEnv({
      NODE_ENV: "test",
      OIDC_ISSUER: issuer,
      OIDC_JWKS_URL: "http://127.0.0.1:18097/jwks",
      OIDC_AUDIENCE: clientAudience,
      OIDC_OPS_AUDIENCE: opsAudience,
    } as never);
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv as never);
  });

  test("无会话 401，缺 funnel.read 能力 403", async () => {
    const app = appWith({ capabilities: ["quota.read"] });
    expect((await app.request(summaryUrl("event=first_login&day=2026-10-29"))).status).toBe(401);

    const response = await app.request(summaryUrl("event=first_login&day=2026-10-29"), {
      headers: await authHeader(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "platform-operator-capability-missing" } });
  });

  test("只接受已定义事件与合法 UTC 日，不接受任何额外参数", async () => {
    const app = appWith({ capabilities: ["funnel.read"] });
    const auth = await authHeader();
    for (const params of [
      "event=made_up&day=2026-10-29",
      "event=first_login&day=2026-02-30",
      "event=first_login&day=29-10-2026",
      "event=first_login&day=2026-10-29&workspace=ws_a",
      "event=first_login&day=2026-10-29&event=template_created",
      "event=first_login",
      "day=2026-10-29",
    ]) {
      const response = await app.request(summaryUrl(params), { headers: auth });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: expect.stringMatching(/^funnel-summary-invalid-/u) } });
    }
  });

  test("恰好达到阈值时返回精确计数", async () => {
    const app = appWith({ capabilities: ["funnel.read"], summary: async () => ({ totalCount: 5, workspaceCount: 3 }) });
    const response = await app.request(summaryUrl("event=first_login&day=2026-10-29"), { headers: await authHeader() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      event: "first_login",
      day: "2026-10-29",
      state: "reported",
      totalCount: 5,
      workspaceCount: 3,
    });
  });

  test("任一低样本条件触发抑制，且不回传精确计数", async () => {
    const auth = await authHeader();
    for (const aggregate of [
      { totalCount: 4, workspaceCount: 10 },
      { totalCount: 100, workspaceCount: 2 },
    ]) {
      const app = appWith({ capabilities: ["funnel.read"], summary: async () => aggregate });
      const response = await app.request(summaryUrl("event=first_login&day=2026-10-29"), { headers: auth });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ state: "suppressed", totalCount: null, workspaceCount: null });
      expect(JSON.stringify(body)).not.toContain(`"totalCount":${aggregate.totalCount}`);
      expect(JSON.stringify(body)).not.toContain(`"workspaceCount":${aggregate.workspaceCount}`);
    }
  });

  test("空窗与低样本分开标记，覆盖状态始终未知", async () => {
    const auth = await authHeader();
    const empty = appWith({ capabilities: ["funnel.read"], summary: async () => ({ totalCount: 0, workspaceCount: 0 }) });
    const emptyResponse = await empty.request(summaryUrl("event=first_login&day=2026-10-29"), { headers: auth });
    expect(await emptyResponse.json()).toMatchObject({
      state: "empty",
      totalCount: 0,
      workspaceCount: 0,
      coverage: { state: "unknown", complete: false, reason: "no_collection_coverage_signal" },
    });

    const reported = appWith({ capabilities: ["funnel.read"], summary: async () => ({ totalCount: 9, workspaceCount: 4 }) });
    const reportedResponse = await reported.request(summaryUrl("event=first_login&day=2026-10-29"), { headers: auth });
    expect(await reportedResponse.json()).toMatchObject({
      state: "reported",
      coverage: { state: "unknown", complete: false },
    });
  });

  test("响应不含工作区标识，上游错误正文不外发", async () => {
    const app = appWith({
      capabilities: ["funnel.read"],
      summary: async () => {
        throw new Error("ECONNREFUSED ws://internal-db:8000/rpc secret-upstream-body");
      },
    });
    const response = await app.request(summaryUrl("event=first_login&day=2026-10-29"), { headers: await authHeader() });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("funnel-summary-upstream-unavailable");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("secret-upstream-body");
    expect(text).not.toContain("workspaceKey");
    expect(text).not.toContain("workspace_key");
  });

  test("既有 funnel-counts 契约保持不变", async () => {
    const row = { event: "first_login", day: "2026-10-29", workspaceKey: "ab12", count: 3 };
    const app = appWith({ capabilities: ["funnel.read"], list: async () => [row] });
    const auth = await authHeader();

    const response = await app.request("/api/ops/funnel-counts?event=first_login&day=2026-10-29&limit=10", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counts: [row] });

    const invalid = await app.request("/api/ops/funnel-counts?limit=501", { headers: auth });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "funnel-counts-invalid-limit" } });
  });
});