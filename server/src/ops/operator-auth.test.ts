import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import { overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { requirePlatformOperator, type PlatformOperatorCapabilityReader } from "./operator-auth";
import type { OidcTokenActivityChecker } from "../oidc/introspection";

const issuer = "http://127.0.0.1:18082/issuer";
const opsAudience = "https://ops.example.test/mcp";
const clientAudience = "https://auth.example.test";
const jwksPort = 18082;

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

describe("platform operator authentication", () => {
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

  function createApp(
    reader: PlatformOperatorCapabilityReader,
    tokenActivityChecker?: OidcTokenActivityChecker,
  ): Hono<AppBindings> {
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.get("/ops", requirePlatformOperator("content.read", { reader, tokenActivityChecker }), (c) =>
      c.json({ subject: c.var.platformOperator.subject, capabilities: c.var.platformOperator.capabilities }),
    );
    return app;
  }

  test("requires the separate ops audience and live capability lookup", async () => {
    let revoked = false;
    const reader: PlatformOperatorCapabilityReader = {
      async getCapabilities(subject) {
        expect(subject).toBe("operator:ada");
        return revoked ? [] : ["content.read"];
      },
    };
    const app = createApp(reader);
    const valid = await app.fetch(new Request("http://localhost/ops", {
      headers: { authorization: `Bearer ${await signToken(opsAudience)}` },
    }));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ subject: "operator:ada", capabilities: ["content.read"] });

    const wrongAudience = await app.fetch(new Request("http://localhost/ops", {
      headers: { authorization: `Bearer ${await signToken(clientAudience)}` },
    }));
    expect(wrongAudience.status).toBe(401);
    expect(await wrongAudience.json()).toMatchObject({ error: { code: "oidc-ops-audience-invalid" } });

    revoked = true;
    const afterRevocation = await app.fetch(new Request("http://localhost/ops", {
      headers: { authorization: `Bearer ${await signToken(opsAudience)}` },
    }));
    expect(afterRevocation.status).toBe(403);
    expect(await afterRevocation.json()).toMatchObject({ error: { code: "platform-operator-inactive" } });
  });

  test("rejects a JWT that the IdP reports as revoked", async () => {
    const reader: PlatformOperatorCapabilityReader = {
      async getCapabilities() {
        return ["content.read"];
      },
    };
    const app = createApp(reader, async () => false);
    const response = await app.fetch(new Request("http://localhost/ops", {
      headers: { authorization: `Bearer ${await signToken(opsAudience)}` },
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "oidc-revoked" } });
  });
});
