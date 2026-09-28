/**
 * SCK-LCA-03 隔离联调用 fixture IdP（非生产 IdP，不仿造 ma_hono）。
 * 只实现候选联调需要的最小 OIDC 面：
 *   GET  /authorize        — 真实 Auth Code + S256 PKCE 流程；subject 参数或用户选择页定测试身份
 *   POST /token            — confidential basic + PKCE 校验；签发前真实调用应用的 default-scope hook
 *   GET  /jwks.json        — 本次运行的 ES256 公钥
 *   POST /scope            — 与应用 idp-scope-adapter 同一端点；workspace 换 scope 与 content_reader.v1 换票
 *   POST /dev/mint         — 种子/负例直接签 token（无浏览器步骤用）
 * 用法：bun .scratch/sck-lca-03-e2e/fixture-idp.ts
 * 环境：PORT（默认 19001）、APP_BASE（default-scope hook 所在应用）、IDP_HOOK_SECRET。
 */

import { SignJWT, generateKeyPair, exportJWK, jwtVerify, createLocalJWKSet } from "jose";

const PORT = Number(process.env.PORT ?? 19001);
const ISSUER = `http://127.0.0.1:${PORT}`;
const APP_BASE = process.env.APP_BASE ?? "http://127.0.0.1:18080";
const HOOK_SECRET = process.env.IDP_HOOK_SECRET ?? "fixture-hook-secret";
export const CLIENT_ID = "fixture-web";
export const CLIENT_SECRET = "fixture-secret";
export const AUDIENCE = "fixture-aud";
const MAX_CONTENT_READER_TTL = 900;
const WORKSPACE_TTL = 3600;

/** 固定测试身份：alice/bob 是 ws_alpha 管理员与成员，carol 已移除，eve 属于 ws_beta，ops1 运营。 */
export const USERS: Record<string, { email: string }> = {
  alice: { email: "alice@fixture.test" },
  bob: { email: "bob@fixture.test" },
  carol: { email: "carol@fixture.test" },
  eve: { email: "eve@fixture.test" },
  ops1: { email: "ops@fixture.test" },
  mallory: { email: "mallory@fixture.test" },
};

// 密钥持久化到 /tmp（仅本机隔离环境），DB 端 JWKS 缓存重启/轮换才一致。
const KEY_FILE = "/tmp/sck-lca-03-e2e-jwk.json";
let keys: { publicKey: CryptoKey; privateKey: CryptoKey };
const saved = await Bun.file(KEY_FILE).json().catch(() => null) as { priv?: unknown; pub?: unknown } | null;
if (saved?.priv && saved?.pub) {
  keys = {
    publicKey: await crypto.subtle.importKey("jwk", saved.pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
    privateKey: await crypto.subtle.importKey("jwk", saved.priv, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
  };
} else {
  const generated = await generateKeyPair("ES256", { extractable: true });
  keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  const priv = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", keys.publicKey);
  await Bun.write(KEY_FILE, JSON.stringify({ priv, pub }), { mode: 0o600 });
}
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "ES256", use: "sig" };
const jwks = createLocalJWKSet({ keys: [publicJwk] });

type PendingCode = {
  subject: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  nonce?: string;
  audience?: string;
};
const codes = new Map<string, PendingCode>();

function basicClientOk(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  return Buffer.from(match[1]!, "base64").toString() === `${CLIENT_ID}:${CLIENT_SECRET}`;
}

async function sign(payload: Record<string, unknown>, expiresIn: number): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(keys.privateKey);
}

async function defaultScope(subject: string, email?: string): Promise<{ db: string; ac: string } | null> {
  const url = new URL(`${APP_BASE}/api/internal/idp/default-scope`);
  url.searchParams.set("subject", subject);
  if (email) url.searchParams.set("email", email);
  const res = await fetch(url, { headers: { authorization: `Bearer ${HOOK_SECRET}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { db?: string; ac?: string };
  if (typeof body.db !== "string" || typeof body.ac !== "string") return null;
  return { db: body.db, ac: body.ac };
}

async function verifySubject(token: string) {
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    return payload;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}
const err = (error: string, status = 400) => json({ error }, status);

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/.well-known/openid-configuration") {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (path === "/jwks.json") return json({ keys: [publicJwk] });

    if (path === "/authorize" && req.method === "GET") {
      const subject = url.searchParams.get("subject");
      if (subject && USERS[subject]) {
        return issueCode(url, subject);
      }
      const rows = Object.keys(USERS)
        .map((sub) => `<li><a href="/authorize?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), subject: sub })}">${sub}</a></li>`)
        .join("");
      return new Response(`<html><body><h1>fixture idp</h1><p>choose test subject:</p><ul>${rows}</ul></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }

    if (path === "/token" && req.method === "POST") {
      if (!basicClientOk(req)) return err("invalid_client", 401);
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") !== "authorization_code") return err("unsupported_grant_type");
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending) return err("invalid_grant");
      if ((form.get("redirect_uri") ?? "") !== pending.redirectUri) return err("invalid_grant");
      const verifier = form.get("code_verifier") ?? "";
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const computed = digest.toString("base64url");
      if (computed !== pending.codeChallenge) return err("invalid_grant");

      const scope = await defaultScope(pending.subject, USERS[pending.subject]?.email);
      if (!scope) return err("invalid_grant");

      const expiresIn = WORKSPACE_TTL;
      const accessToken = await sign({
        sub: pending.subject,
        email: USERS[pending.subject]?.email,
        ns: "main",
        db: scope.db,
        ac: scope.ac,
        RL: ["Owner"],
        scope: pending.scope,
      }, expiresIn);
      const idToken = await new SignJWT({
        sub: pending.subject,
        email: USERS[pending.subject]?.email,
        ...(pending.nonce ? { nonce: pending.nonce } : {}),
      })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .setIssuer(ISSUER)
        .setAudience(pending.clientId)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
        .sign(keys.privateKey);
      return json({
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: pending.scope,
      });
    }

    if (path === "/scope" && req.method === "POST") {
      if (!basicClientOk(req)) return err("invalid_client", 401);
      const body = (await req.json().catch(() => null)) as
        | { subject_token?: string; claims?: Record<string, unknown> }
        | null;
      if (!body || typeof body.subject_token !== "string" || !body.claims) return err("invalid_request");
      const subject = await verifySubject(body.subject_token);
      if (!subject?.sub) return err("invalid_grant");
      const claims = body.claims;

      if (claims.ac === "content_reader") {
        const claimKeys = Object.keys(claims).sort();
        if (JSON.stringify(claimKeys) !== JSON.stringify(["ac", "db", "entitlement_revision", "lease_end", "workspace_id"].sort())) {
          return err("invalid_request");
        }
        if (subject.ac === "content_reader") return err("invalid_scope");
        if (typeof claims.db !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/u.test(claims.db)) return err("invalid_scope");
        if (typeof claims.workspace_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(claims.workspace_id)) return err("invalid_request");
        if (typeof claims.entitlement_revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(claims.entitlement_revision)) return err("invalid_request");
        if (typeof claims.lease_end !== "number" || !Number.isInteger(claims.lease_end)) return err("invalid_lifetime");
        const now = Math.floor(Date.now() / 1000);
        const subjectExp = typeof subject.exp === "number" ? subject.exp : now + WORKSPACE_TTL;
        const exp = Math.min(subjectExp, claims.lease_end, now + MAX_CONTENT_READER_TTL);
        if (exp <= now) return err("invalid_lifetime");
        const accessToken = await new SignJWT({
          ac: "content_reader",
          ns: "main",
          db: claims.db,
          workspace_id: claims.workspace_id,
          entitlement_revision: claims.entitlement_revision,
          scope: "openid profile",
        })
          .setSubject(subject.sub)
          .setProtectedHeader({ alg: "ES256", kid: "fixture" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime(exp)
          .sign(keys.privateKey);
        return json({ access_token: accessToken, token_type: "Bearer", expires_in: exp - now, scope: "openid profile" }, 200, { "cache-control": "no-store" });
      }

      if (typeof claims.db !== "string" || (claims.ac !== "admin" && claims.ac !== "participant")) {
        return err("invalid_scope");
      }
      if (subject.ac === "content_reader") return err("invalid_scope");
      const now = Math.floor(Date.now() / 1000);
      const subjectExp = typeof subject.exp === "number" ? subject.exp : now + WORKSPACE_TTL;
      const exp = Math.min(subjectExp, now + WORKSPACE_TTL);
      const rl = Array.isArray(claims.RL) ? claims.RL : [claims.ac === "admin" ? "Owner" : "Editor"];
      const accessToken = await sign({
        sub: subject.sub,
        email: subject.email,
        ns: "main",
        db: claims.db,
        ac: claims.ac,
        RL: rl,
        scope: "openid profile",
      }, exp - now);
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: exp - now, scope: "openid profile" }, 200, { "cache-control": "no-store" });
    }

    if (path === "/dev/mint" && req.method === "POST") {
      if (!basicClientOk(req)) return err("invalid_client", 401);
      const body = (await req.json().catch(() => null)) as
        | { subject?: string; claims?: Record<string, unknown>; expiresIn?: number }
        | null;
      if (!body?.subject || !USERS[body.subject]) return err("invalid_request");
      const accessToken = await new SignJWT({
        sub: body.subject,
        email: USERS[body.subject]?.email,
        ...(body.claims ?? {}),
      })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + (body.expiresIn ?? 300))
        .sign(keys.privateKey);
      return json({ access_token: accessToken });
    }

    return new Response("fixture idp", { status: 404 });
  },
});

function issueCode(url: URL, subject: string): Response {
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const code = crypto.randomUUID();
  codes.set(code, {
    subject,
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri,
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    scope: url.searchParams.get("scope") ?? "openid",
    nonce: url.searchParams.get("nonce") ?? undefined,
    audience: url.searchParams.get("audience") ?? undefined,
  });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

console.info(`[fixture-idp] listening ${ISSUER} (app hook: ${APP_BASE})`);
export { server };
