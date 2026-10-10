import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { expect, test } from "bun:test";
import {
  COMPANY_PROOF_ALG, COMPANY_PROOF_AUDIENCE, COMPANY_PROOF_GOAL, COMPANY_PROOF_ISSUER,
  COMPANY_PROOF_MAX_AGE_SECONDS, COMPANY_PROOF_PROJECT, COMPANY_PROOF_TRUST, COMPANY_PROOF_TYP,
} from "@surreal-ck/shared";
import { verifyCompanyProof, statusCapabilityHash } from "./company-proof";

/** 测试自签钥匙：生产信任锚不可用于本地签名，故仅在此注入；生产路径固定用 COMPANY_PROOF_TRUST。 */
const testPair = generateKeyPairSync("ed25519");
const testJwk = testPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const testKid = createHash("sha256").update(JSON.stringify(testJwk)).digest("hex").slice(0, 32);
const anchor = { alg: "EdDSA", kid: testKid, jwk: testJwk };
const otherPair = generateKeyPairSync("ed25519");
const otherJwk = otherPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const now = 1_800_000_000_000;
const seconds = Math.floor(now / 1000);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const documentHash = digest("document");
  const manifest = {
    schemaVersion: 1, goalId: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, env: "production",
    activityId: "synthetic-disabled-sensenova", workspaceSlug: "ui01", documentHash,
    service: { accountRef: "synthetic-existing-service", endpoint: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite", priceRevision: "synthetic-unsupported" },
    budget: { currency: "USD", totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true },
    identities: [
      { alias: "LCA04_REMOVABLE", workspaceRole: "admin", billingRole: "owner" },
      { alias: "LCA04_MEMBER", workspaceRole: "participant", billingRole: "member" },
    ],
    configurationDigest: digest("configuration"),
  };
  return {
    contractVersion: 1, type: "development-disabled", paidCallsAllowed: 0, scope: "register-disabled",
    project: COMPANY_PROOF_PROJECT, env: "production", goal: COMPANY_PROOF_GOAL, requestTask: "synthetic-task",
    lease: { goal: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, role: "engineering", employee: "synthetic-employee", taskId: "synthetic-task", delivery: "synthetic-delivery", fence: 1 },
    approval: null, documentHash, manifest, configurationDigest: manifest.configurationDigest,
    identities: [
      { alias: "LCA04_REMOVABLE", subject: "subject-owner", spaceId: "workspace:ui01", database: "ws_ui01", workspaceRole: "admin", billingRole: "owner", billingAccountRef: "ui01-account" },
      { alias: "LCA04_MEMBER", subject: "subject-member", spaceId: "workspace:ui01", database: "ws_ui01", workspaceRole: "participant", billingRole: "member", billingAccountRef: "ui01-account" },
    ],
    identitiesDigest: digest("identities"), jti: "synthetic-jti-0001", nonce: "abcdefghijklmnopqrstuvwx",
    iat: seconds, exp: seconds + 60,
    status: { path: "/internal-ai/status", bearer: "A".repeat(43) },
    iss: COMPANY_PROOF_ISSUER, aud: COMPANY_PROOF_AUDIENCE, ...overrides,
  };
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

function signWith(payload: Record<string, unknown>, key: typeof testPair.privateKey, kid: string, header: Record<string, unknown> = {}): string {
  const head = { alg: "EdDSA", typ: COMPANY_PROOF_TYP, kid, ...header };
  const message = `${encode(head)}.${encode(payload)}`;
  return `${message}.${sign(null, Buffer.from(message), key).toString("base64url")}`;
}

const valid = () => signWith(claims(), testPair.privateKey, testKid);

test("pinned company trust anchor is internally consistent", () => {
  // 固定 kid 必须由固定公钥导出：任一侧写错都会在这里失败，避免放行一个不存在锚点。
  expect(COMPANY_PROOF_TRUST.alg).toBe(COMPANY_PROOF_ALG);
  expect(COMPANY_PROOF_TRUST.kid).toBe(createHash("sha256").update(JSON.stringify(COMPANY_PROOF_TRUST.jwk)).digest("hex").slice(0, 32));
  expect(COMPANY_PROOF_TRUST.jwk.crv).toBe("Ed25519");
  expect(COMPANY_PROOF_TRUST.jwk.kty).toBe("OKP");
  expect(COMPANY_PROOF_MAX_AGE_SECONDS).toBe(300);
});

test("a correctly signed development-disabled proof verifies with the actual SenseNova model", () => {
  const value = verifyCompanyProof(valid(), now, anchor);
  expect(value.type).toBe("development-disabled");
  expect(value.paidCallsAllowed).toBe(0);
  expect(value.manifest.service.model).toBe("sensenova-6.8-flash-lite");
  expect(value.manifest.service.endpoint).toBe("https://token.sensenova.cn/v1");
  expect(value.identities.map(i => i.alias)).toEqual(["LCA04_REMOVABLE", "LCA04_MEMBER"]);
});

test("wrong key, wrong kid, wrong alg or wrong typ are rejected", () => {
  expect(() => verifyCompanyProof(signWith(claims(), otherPair.privateKey, testKid), now, anchor)).toThrow(/签名无效/);
  expect(() => verifyCompanyProof(signWith(claims(), testPair.privateKey, createHash("sha256").update(JSON.stringify(otherJwk)).digest("hex").slice(0, 32)), now, anchor)).toThrow(/信任锚不匹配/);
  expect(() => verifyCompanyProof(signWith(claims(), testPair.privateKey, testKid, { alg: "HS256" }), now, anchor)).toThrow(/信任锚不匹配/);
  expect(() => verifyCompanyProof(signWith(claims(), testPair.privateKey, testKid, { typ: "sck-internal-ai-status+jwt" }), now, anchor)).toThrow(/信任锚不匹配/);
});

test("tampered payload or truncated token are rejected", () => {
  const jwt = valid();
  const [head, body, signature] = jwt.split(".") as [string, string, string];
  const tampered = Buffer.from(JSON.stringify({ ...claims(), goal: COMPANY_PROOF_GOAL, paidCallsAllowed: 1 })).toString("base64url");
  expect(() => verifyCompanyProof(`${head}.${tampered}.${signature}`, now, anchor)).toThrow(/签名无效/);
  expect(() => verifyCompanyProof(`${head}.${body}`, now, anchor)).toThrow(/格式无效/);
  expect(() => verifyCompanyProof("not-a-jwt", now, anchor)).toThrow(/格式无效/);
  expect(() => verifyCompanyProof(`${head}.${body}.${signature}.${signature}`, now, anchor)).toThrow(/格式无效/);
});

test("time window is bounded to 300 seconds and never accepts future or expired proofs", () => {
  expect(() => verifyCompanyProof(signWith(claims({ exp: seconds + COMPANY_PROOF_MAX_AGE_SECONDS + 1 }), testPair.privateKey, testKid), now, anchor)).toThrow(/时间窗非法/);
  expect(() => verifyCompanyProof(signWith(claims({ iat: seconds + 5 }), testPair.privateKey, testKid), now, anchor)).toThrow(/时间窗非法/);
  expect(() => verifyCompanyProof(signWith(claims({ iat: seconds - 400, exp: seconds - 100 }), testPair.privateKey, testKid), now, anchor)).toThrow(/已过期/);
  expect(() => verifyCompanyProof(signWith(claims({ exp: seconds }), testPair.privateKey, testKid), now, anchor)).toThrow(/已过期/);
  expect(verifyCompanyProof(signWith(claims({ iat: seconds, exp: seconds + COMPANY_PROOF_MAX_AGE_SECONDS }), testPair.privateKey, testKid), now, anchor).jti).toBe("synthetic-jti-0001");
});

test("foreign issuer, audience, project or goal are rejected", () => {
  expect(() => verifyCompanyProof(signWith(claims({ iss: "https://evil.example" }), testPair.privateKey, testKid), now, anchor)).toThrow(/签发方或受众不匹配/);
  expect(() => verifyCompanyProof(signWith(claims({ aud: "https://evil.example" }), testPair.privateKey, testKid), now, anchor)).toThrow(/签发方或受众不匹配/);
  expect(() => verifyCompanyProof(signWith(claims({ project: "other" }), testPair.privateKey, testKid), now, anchor)).toThrow(/目标或项目不匹配/);
  expect(() => verifyCompanyProof(signWith(claims({ goal: "0000000000000000" }), testPair.privateKey, testKid), now, anchor)).toThrow(/目标或项目不匹配/);
});

test("unknown claim fields, missing fields and wrong types are rejected", () => {
  expect(() => verifyCompanyProof(signWith(claims({ surprise: true }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  expect(() => verifyCompanyProof(signWith(claims({ identities: [] }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  expect(() => verifyCompanyProof(signWith(claims({ paidCallsAllowed: 2 }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  expect(() => verifyCompanyProof(signWith(claims({ nonce: "short" }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  expect(() => verifyCompanyProof(signWith(claims({ iat: "1" }), testPair.privateKey, testKid), now, anchor)).toThrow(/时间声明/);
  // manifest 里换成无点号控制模型也必须被接受（老合法值保留），换成危险值必须拒绝。
  expect(verifyCompanyProof(signWith(claims({ manifest: { ...claims().manifest as object, service: { ...(claims().manifest as { service: object }).service, model: "sensenova-flash-lite" } } }), testPair.privateKey, testKid), now, anchor).manifest.service.model).toBe("sensenova-flash-lite");
  for (const model of ["", "a\nb", "a..b", ".a", "a.", "a/b", "https://token.sensenova.cn", "a%2eb", "模型", "a".repeat(129)]) {
    expect(() => verifyCompanyProof(signWith(claims({ manifest: { ...claims().manifest as object, service: { ...(claims().manifest as { service: object }).service, model } } }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  }
});

test("digest must match the embedded manifest and document hash", () => {
  expect(() => verifyCompanyProof(signWith(claims({ configurationDigest: digest("other") }), testPair.privateKey, testKid), now, anchor)).toThrow(/摘要与文档不一致/);
  expect(() => verifyCompanyProof(signWith(claims({ documentHash: digest("other") }), testPair.privateKey, testKid), now, anchor)).toThrow(/摘要与文档不一致/);
});

test("paid-call许可, registration scope and enable scope are cross-checked", () => {
  // 禁用证明不得携带付费许可。
  expect(() => verifyCompanyProof(signWith(claims({ paidCallsAllowed: 1 }), testPair.privateKey, testKid), now, anchor)).toThrow(/不得携带付费许可/);
  // 登记范围只接受 development-disabled。
  expect(() => verifyCompanyProof(signWith(claims({ type: "approved-service", paidCallsAllowed: 1 }), testPair.privateKey, testKid), now, anchor)).toThrow(/登记范围与证明类型不符/);
  // 启用范围必须同时带受审服务证据与独立批准。
  expect(() => verifyCompanyProof(signWith(claims({ scope: "enable", type: "approved-service", paidCallsAllowed: 1 }), testPair.privateKey, testKid), now, anchor)).toThrow(/必须带受审服务证据与独立批准/);
  expect(() => verifyCompanyProof(signWith(claims({ scope: "enable", type: "development-disabled", paidCallsAllowed: 0 }), testPair.privateKey, testKid), now, anchor)).toThrow(/必须带受审服务证据与独立批准/);
  const approved = claims({
    scope: "enable", type: "approved-service", paidCallsAllowed: 1,
    approval: { taskId: "synthetic-approval", version: 3, action: "accept", auditId: "audit:1", reviewer: "synthetic-reviewer", digest: digest("configuration") },
  });
  expect(verifyCompanyProof(signWith(approved, testPair.privateKey, testKid), now, anchor).approval?.taskId).toBe("synthetic-approval");
});

test("identity claim shape is strict, but two-role semantics belong to the registration layer", () => {
  const swap = claims({ identities: [claims().identities[1], claims().identities[0]] });
  expect(() => verifyCompanyProof(swap, now, anchor)).toThrow(); // zod tuple 顺序固定
  // manifest 里的冻结配对由验签层强制：owner/admin 与 member/participant 不可互换。
  const wrongManifestRole = claims({ manifest: { ...claims().manifest as object, identities: [{ alias: "LCA04_REMOVABLE", workspaceRole: "admin", billingRole: "member" }, { alias: "LCA04_MEMBER", workspaceRole: "participant", billingRole: "member" }] } });
  expect(() => verifyCompanyProof(signWith(wrongManifestRole, testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
  const otherSpace = claims({ identities: [(claims().identities as object[])[0], { ...(claims().identities as object[])[1] as object, spaceId: "workspace:other" }] });
  expect(verifyCompanyProof(signWith(otherSpace, testPair.privateKey, testKid), now, anchor).identities[1]!.spaceId).toBe("workspace:other");
});

test("the status capability secret is only ever reduced to a hash", () => {
  const bearer = "B".repeat(43);
  const value = verifyCompanyProof(signWith(claims({ status: { path: "/internal-ai/status", bearer } }), testPair.privateKey, testKid), now, anchor);
  expect(value.status.bearer).toBe(bearer);
  expect(statusCapabilityHash(bearer)).toBe(createHash("sha256").update(bearer).digest("hex"));
  expect(statusCapabilityHash(bearer)).not.toContain(bearer);
  expect(statusCapabilityHash(bearer)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => verifyCompanyProof(signWith(claims({ status: { path: "/internal-ai/status", bearer: "too-short" } }), testPair.privateKey, testKid), now, anchor)).toThrow(/声明不合法/);
});
