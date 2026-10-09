import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { type PlatformOperatorCapabilityReader } from "../ops/operator-auth";
import { createProTrialRoutes, requireTrialObserver } from "./pro-trial";
import { ProTrialObservation } from "../ops/pro-trial-observation";

const issuer = "http://127.0.0.1:18092/issuer";
const opsAudience = "https://ops.example.test/mcp";
const clientAudience = "https://auth.example.test";
const jwksPort = 18092;

let privateKey: CryptoKey;
let publicJwk: JWK;
let jwksServer: ReturnType<typeof Bun.serve>;
let originalEnv: Record<string, unknown>;

async function signToken(audience: string): Promise<string> {
  return new SignJWT({ email: "operator@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "ops-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("operator:ada")
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("controlled read-only trial routes", () => {
  beforeAll(async () => {
    const { env } = await import("../env");
    originalEnv = { ...env };
    overrideEnv({
      NODE_ENV: "test",
      OIDC_ISSUER: issuer,
      OIDC_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
      OIDC_AUDIENCE: clientAudience,
      OIDC_OPS_AUDIENCE: opsAudience,
    });
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: "ops-key", alg: "RS256", use: "sig" };
    jwksServer = Bun.serve({
      port: jwksPort,
      fetch(request) {
        return new URL(request.url).pathname === "/jwks"
          ? Response.json({ keys: [publicJwk] })
          : new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv as never);
  });

  let reads = 0;
  const observation = new ProTrialObservation(async () => ({
    async query(_sql: string, vars?: Record<string, unknown>) {
      reads++;
      if (vars) {
        expect(vars).toEqual({ accountKey: "dedicated", subject: "owner" });
        return [{ serverTime: "2026-10-09T00:00:00Z", account: null, membership: null,
          eligibility: null, trials: [], slots: [], claims: [] }];
      }
      return [{ serverTime: "2026-10-09T00:00:00Z", configuration: null, revision: null }];
    },
  }));
  const unavailable = async (): Promise<never> => { throw new Error("customer/write path must not run"); };
  const customer = { accounts: unavailable, preview: unavailable, start: unavailable, status: unavailable };
  function createApp(reader: PlatformOperatorCapabilityReader) {
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createProTrialRoutes(customer, undefined, observation, () => requireTrialObserver({ reader })));
    return app;
  }
  const request = async (app: Hono<AppBindings>, path: string, audience = opsAudience) => app.request(path, {
    headers: { authorization: `Bearer ${await signToken(audience)}` },
  });
  test("GET reads twice, does not invoke customer/write path; capability revocation denies next read", async () => {
    let enabled = true;
    const app = createApp({ async getCapabilities() { return enabled ? ["subscription.manage"] : []; } });
    const before = reads;
    for (let n = 0; n < 2; n++) {
      const response = await request(app, "/api/ops/pro-trial/configuration");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ configurationState: "missing", configuration: null });
    }
    expect(reads - before).toBe(2);
    enabled = false;
    expect((await request(app, "/api/ops/pro-trial/configuration")).status).toBe(403);
    expect(reads - before).toBe(2);
  });
  test("customer audience, inactive operator and wrong capability cannot read any observation entry", async () => {
    const before = reads;
    for (const path of ["/api/ops/pro-trial/configuration", "/api/ops/pro-trial/eligibility?accountKey=a&subject=owner", "/api/ops/runtime-version"]) {
      const capable = createApp({ async getCapabilities() { return ["subscription.manage"]; } });
      expect((await request(capable, path, clientAudience)).status).toBe(403);
      for (const capabilities of [[], ["content.read"]] as const) {
        expect((await request(createApp({ async getCapabilities() { return capabilities; } }), path)).status).toBe(403);
      }
      expect((await capable.request(path)).status).toBe(401);
    }
    expect(reads).toBe(before);
  });
  test("authorized account read passes only the explicit target, no account enumeration", async () => {
    const app = createApp({ async getCapabilities() { return ["subscription.manage"]; } });
    const response = await request(app, "/api/ops/pro-trial/eligibility?accountKey=dedicated&subject=owner");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accountState: "missing", subject: "owner", active: null, eligible: null });
  });
  test("account list, omitted target and extra parameters are rejected", async () => {
    const app = createApp({ async getCapabilities() { return ["subscription.manage"]; } });
    for (const query of ["", "?accountKey=a", "?subject=owner", "?accountKey=a&subject=owner&limit=100"]) {
      expect((await request(app, `/api/ops/pro-trial/eligibility${query}`)).status).toBe(400);
    }
  });
});
