import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
import type { AppBindings } from "../hono-types";
import { handleError } from "./error";
import { requireOidc } from "./oidc";

const issuer = "http://127.0.0.1:18081/issuer";
const audience = "surreal-ck-test";
const jwksPort = 18081;

let privateKey: CryptoKey;
let wrongPrivateKey: CryptoKey;
let publicJwk: JWK;
let jwksServer: ReturnType<typeof Bun.serve>;
let jwksHits = 0;

function createProtectedApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.get("/protected", requireOidc(), (c) =>
    c.json({
      subject: c.var.user.subject,
      email: c.var.user.email,
    })
  );
  return app;
}

async function signToken(
  overrides: {
    subject?: string;
    email?: string | null;
    surrealEmail?: string;
    audience?: string;
    expiresIn?: string;
    useWrongKey?: boolean;
  } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (overrides.email !== null) {
    payload.email = overrides.email ?? "ada@example.test";
  }
  if (overrides.surrealEmail) {
    payload["https://surrealdb.com/email"] = overrides.surrealEmail;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? "user:ada")
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(overrides.useWrongKey ? wrongPrivateKey : privateKey);
}

import { overrideEnv } from "../env";

let originalEnv: any;

describe("OIDC middleware", () => {
  const originalError = console.error;

  beforeAll(async () => {
    const { env: currentEnv } = await import("../env");
    originalEnv = { ...currentEnv };
    overrideEnv({
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: audience,
      OIDC_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
    });

    const keyPair = await generateKeyPair("RS256", { extractable: true });
    const wrongKeyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    wrongPrivateKey = wrongKeyPair.privateKey;
    publicJwk = {
      ...(await exportJWK(keyPair.publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };

    jwksServer = Bun.serve({
      port: jwksPort,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/jwks") {
          jwksHits += 1;
          return Response.json({ keys: [publicJwk] });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    jwksServer.stop(true);
    if (originalEnv) {
      overrideEnv(originalEnv);
    }
  });

  afterEach(() => {
    console.error = originalError;
  });

  test("rejects protected routes without a bearer token", async () => {
    const app = createProtectedApp();

    const response = await app.fetch(new Request("http://localhost/protected"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "oidc-missing" },
    });
  });

  test("accepts a valid token and reuses JWKS inside the cache window", async () => {
    const app = createProtectedApp();
    jwksHits = 0;

    const first = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { authorization: `Bearer ${await signToken()}` },
      }),
    );
    const second = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { authorization: `Bearer ${await signToken({ subject: "user:grace" })}` },
      }),
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ subject: "user:ada", email: "ada@example.test" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ subject: "user:grace", email: "ada@example.test" });
    expect(jwksHits).toBe(1);
  });

  test("uses the SurrealDB email claim when the standard email claim is absent", async () => {
    const app = createProtectedApp();

    const response = await app.fetch(
      new Request("http://localhost/protected", {
        headers: {
          authorization: `Bearer ${await signToken({
            email: null,
            surrealEmail: "yyx6953119@gmail.com",
          })}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subject: "user:ada",
      email: "yyx6953119@gmail.com",
    });
  });

  test("distinguishes expired, bad signature, and bad audience failures", async () => {
    const app = createProtectedApp();
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    const expiredToken = await signToken({ expiresIn: "-1s" });
    const badSignatureToken = await signToken({ useWrongKey: true });
    const badAudienceToken = await signToken({ audience: "wrong-audience" });

    const expired = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { authorization: `Bearer ${expiredToken}` },
      }),
    );
    const badSignature = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { authorization: `Bearer ${badSignatureToken}` },
      }),
    );
    const badAudience = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { authorization: `Bearer ${badAudienceToken}` },
      }),
    );

    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: "oidc-expired" } });
    expect(badSignature.status).toBe(401);
    expect(await badSignature.json()).toMatchObject({ error: { code: "oidc-invalid" } });
    expect(badAudience.status).toBe(401);
    expect(await badAudience.json()).toMatchObject({ error: { code: "oidc-audience-invalid" } });
    const logText = JSON.stringify(logs);
    expect(logText).not.toContain(expiredToken);
    expect(logText).not.toContain(badSignatureToken);
    expect(logText).not.toContain(badAudienceToken);
  });
});
