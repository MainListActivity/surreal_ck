import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { requirePlatformOperator, type PlatformOperatorCapabilityReader } from "../ops/operator-auth";
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

const issuer = "http://127.0.0.1:18094/issuer";
const opsAudience = "https://ops-temp-grant.example.test/mcp";
const clientAudience = "https://auth-temp-grant.example.test";
const GRANTOR = "grantor-subject";
const GRANTEE = "26dba3a6-4392-4840-a856-264d6f07fbee";
const OTHER = "other-operator";

let privateKey: CryptoKey;
let jwksServer: ReturnType<typeof Bun.serve>;
let originalEnv: Record<string, unknown>;

const signed = (subject: string): Promise<string> =>
  new SignJWT({ email: `${subject}@example.test` })
    .setProtectedHeader({ alg: "RS256", kid: "temp-grant-key" })
    .setIssuer(issuer).setAudience(opsAudience).setSubject(subject).setExpirationTime("5m")
    .sign(privateKey);

type MemoryGrant = {
  id: string;
  subject: string;
  capability: string;
  status: string;
  granted_by_subject: string;
  granted_at: Date;
  not_after: Date;
  revoked_at?: Date;
  revoked_by_subject?: string;
  grant_reason?: string | null;
  revoke_reason?: string | null;
  version: number;
};

class MemoryDb {
  grant: MemoryGrant | null = null;
  permanent = new Map<string, Set<string>>();

  seedPermanent(subject: string, capabilities: string[]) {
    this.permanent.set(subject, new Set(capabilities));
  }

  async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const text = sql.replace(/\s+/g, " ");
    if (text.includes("FROM platform_operator_temporary_grant") && text.includes("SELECT capability, status, not_after")) {
      if (!this.grant || this.grant.subject !== params.subject) return [[]];
      return [[this.grant]];
    }
    if (text.includes("FROM platform_operator_temporary_grant") && text.includes("SELECT *")) {
      const grantRows = !this.grant || this.grant.subject !== params.subject ? [] : [this.grant];
      if (text.includes("FROM platform_operator_capability")) {
        const caps = this.permanent.get(String(params.subject)) ?? new Set();
        return [grantRows, [caps.has(String(params.capability)) ? 1 : 0]];
      }
      return [grantRows];
    }
    if (text.includes("INSERT INTO platform_operator_temporary_grant")) {
      this.grant = {
        id: "platform_operator_temporary_grant:1",
        subject: String(params.subject),
        capability: String(params.capability),
        status: "active",
        granted_by_subject: String(params.grantor),
        granted_at: params.grantedAt as Date,
        not_after: params.notAfter as Date,
        grant_reason: (params.reason as string | null) ?? null,
        version: 1,
      };
      return [[{ id: this.grant.id }]];
    }
    if (text.includes("UPDATE $id SET") && text.includes('status = "active"')) {
      if (!this.grant) throw new Error("missing");
      this.grant = {
        ...this.grant,
        status: "active",
        granted_by_subject: String(params.grantor),
        granted_at: params.grantedAt as Date,
        not_after: params.notAfter as Date,
        revoked_at: undefined,
        revoked_by_subject: undefined,
        grant_reason: (params.reason as string | null) ?? null,
        revoke_reason: undefined,
        version: Number(params.version),
      };
      return [[{ id: this.grant.id }]];
    }
    if (text.includes("UPDATE $id SET") && text.includes('status = "revoked"')) {
      if (!this.grant) throw new Error("missing");
      this.grant = {
        ...this.grant,
        status: "revoked",
        revoked_at: params.revokedAt as Date,
        revoked_by_subject: String(params.actor),
        revoke_reason: (params.reason as string | null) ?? null,
        version: Number(params.version),
      };
      return [[{ id: this.grant.id }]];
    }
    throw new Error(`unexpected sql: ${text}`);
  }
}

describe("ops endpoint probe temporary grant routes", () => {
  beforeAll(async () => {
    const { env } = await import("../env");
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
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv as never);
  });

  function readerFor(capabilities: Record<string, string[]>): PlatformOperatorCapabilityReader {
    return {
      async getCapabilities(subject) {
        return (capabilities[subject] ?? []) as never;
      },
    };
  }

  function grantApp(db: MemoryDb, now: () => number) {
    const service = new EndpointProbeTemporaryGrantService(async () => db, "main", now);
    const auth = (capability: string) => requirePlatformOperator(capability as never, {
      reader: readerFor({
        [GRANTOR]: ["quota.read"],
        [GRANTEE]: ["quota.read"],
        [OTHER]: ["quota.read"],
      }),
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

  test("授予仅 grantor 可做；其它主体 403；状态脱敏且含永久能力标记", async () => {
    const db = new MemoryDb();
    db.seedPermanent(GRANTEE, ["quota.read"]);
    const app = grantApp(db, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const denied = await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(OTHER)}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "nope" }),
    });
    expect(denied.status).toBe(403);

    const granted = await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(GRANTOR)}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "fv06" }),
    });
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

  test("撤回与到期后，探针路由对旧会话立即 403；默认关闭仍 503", async () => {
    const db = new MemoryDb();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const temporary = new EndpointProbeTemporaryGrantService(async () => db, "main", () => now);
    await temporary.grant({ actorSubject: GRANTOR });

    const liveReader: PlatformOperatorCapabilityReader = {
      async getCapabilities(subject) {
        const permanent = subject === GRANTEE ? ["quota.read"] as const : subject === GRANTOR ? ["quota.read"] as const : [];
        const temp = await temporary.activeCapabilitiesFor(subject);
        return [...new Set([...permanent, ...temp])].sort() as never;
      },
    };
    const probeAuth = requirePlatformOperator(ENDPOINT_PROBE_TEMPORARY_CAPABILITY, {
      reader: liveReader,
      tokenActivityChecker: async () => true,
    });
    const neverGate = new InternalAiGate(new InternalAiStore(async () => { throw new Error("no store"); }));

    // 开关关闭：即使有临时能力也 503。
    const disabled = new Hono<AppBindings>()
      .route("/", createOpsInternalAiRoutes({
        gate: neverGate,
        runtime: {},
        requireProbeOperator: probeAuth,
        endpointProbe: { enabled: false },
      }))
      .onError(handleError);
    expect((await disabled.request("/api/ops/internal-ai/endpoint-probe", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(GRANTEE)}` },
    })).status).toBe(503);

    const enabled = new Hono<AppBindings>()
      .route("/", createOpsInternalAiRoutes({
        gate: neverGate,
        runtime: {},
        requireProbeOperator: probeAuth,
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

    const ok = await enabled.request("/api/ops/internal-ai/endpoint-probe", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(GRANTEE)}` },
    });
    expect(ok.status).toBe(200);

    await temporary.revoke({ actorSubject: GRANTOR, reason: "done" });
    const afterRevoke = await enabled.request("/api/ops/internal-ai/endpoint-probe", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(GRANTEE)}` },
    });
    expect(afterRevoke.status).toBe(403);
    expect(await afterRevoke.json()).toMatchObject({ error: { code: "platform-operator-capability-missing" } });

    // 重新授予后拨快到过期，旧会话同样 403。
    await temporary.grant({ actorSubject: GRANTOR });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    const afterExpiry = await enabled.request("/api/ops/internal-ai/endpoint-probe", {
      method: "POST",
      headers: { authorization: `Bearer ${await signed(GRANTEE)}` },
    });
    expect(afterExpiry.status).toBe(403);
  });

  test("审计不含原始 subject；其它主体不能读状态", async () => {
    const db = new MemoryDb();
    const app = grantApp(db, () => Date.parse("2026-11-02T08:00:00.000Z"));
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await app.request("/api/ops/internal-ai/endpoint-probe/temporary-grant", {
        method: "POST",
        headers: { authorization: `Bearer ${await signed(GRANTOR)}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "audit" }),
      });
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
