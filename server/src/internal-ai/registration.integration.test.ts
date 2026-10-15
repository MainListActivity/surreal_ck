import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal } from "surrealdb";
import {
  COMPANY_PROOF_AUDIENCE, COMPANY_PROOF_GOAL, COMPANY_PROOF_ISSUER, COMPANY_PROOF_PROJECT, COMPANY_PROOF_TYP,
  TOKEN_PLAN_PLAN_TYPE_FREE,
  type CompanyProofClaims,
} from "@surreal-ck/shared";
import { InternalAiRegistration } from "./registration";
import { HttpError } from "../http-error";
import { verifyCompanyProof } from "./company-proof";
import { InternalAiGate } from "./gate";
import { InternalAiStore, GOAL, MEASUREMENT_DATABASE, hash } from "./store";
import { TARIFFS, worstCost } from "./pricing";

const enabled = process.env.RUN_INTERNAL_AI_FORK_TESTS === "1";
const localTest = test.skipIf(!enabled);
// 公司fork，绝不回退PATH中的上游CLI。
const binary = join(homedir(), ".surrealdb/surreal");
let directory = "";
let endpoint = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;
let registration: InternalAiRegistration;
let gate: InternalAiGate;

const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const kid = createHash("sha256").update(JSON.stringify(jwk)).digest("hex").slice(0, 32);
const anchor = { alg: "EdDSA", kid, jwk };
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const bytesHash = (value: string) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const NOW = Date.now();
const SECONDS = Math.floor(NOW / 1000);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** 每个用例一套独立 subject，避免跨用例共享绑定/撤销状态。 */
function identities(tag: string) {
  return {
    owner: { alias: "LCA04_REMOVABLE", subject: `owner-${tag}`, spaceId: `workspace:${tag}`, database: tag.startsWith("measurement") ? MEASUREMENT_DATABASE : `ws_${tag}`, workspaceRole: "admin", billingRole: "owner", billingAccountRef: `account-${tag}` },
    member: { alias: "LCA04_MEMBER", subject: `member-${tag}`, spaceId: `workspace:${tag}`, database: tag.startsWith("measurement") ? MEASUREMENT_DATABASE : `ws_${tag}`, workspaceRole: "participant", billingRole: "member", billingAccountRef: `account-${tag}` },
  };
}

/** 证据文档：字段必须与 manifest 一致，正文由哈希绑定。 */
function evidenceDocument(tag: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1, type: "development-disabled", accountRef: "synthetic-existing-service",
    endpoint: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite",
    priceRevision: "synthetic-unsupported", currency: "USD", balanceNanoUsd: 0,
    sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(),
    autoTopupDisabled: true, serviceApproved: false, ...over,
  });
}

/** 配额型受审证据 v2：官方 Token Plan 出处、积分配额与账户计划类型读回表达可用性，无 USD 余额语义。 */
function tokenPlanDocument(over: Record<string, unknown> = {}): string {
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  return JSON.stringify({
    schemaVersion: 2, type: "reviewed-token-plan", accountRef: "synthetic-sensenova-account",
    endpoint: `https://${tariff.host}/v1`, model: tariff.model, priceRevision: tariff.revision,
    planName: "SenseNova Token Plan 公测", planSourceUrl: "https://www.sensenova.cn/token-plan",
    accountPlanType: TOKEN_PLAN_PLAN_TYPE_FREE,
    quotaUnit: "points", quotaAmount: 60000, quotaWindowSeconds: 18000, quotaRemaining: 60000,
    sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(),
    serviceApproved: true, ...over,
  });
}

/** 按公司 proof-contract 的 configurationDigest 规则：去 digest 后 manifest 的 canonical sha256。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** 按公司 proof-bridge 的 sign('proof', …) 形状构造并自签一份证明；documentHash 由真实文档字节算。 */
function proof(tag: string, overrides: {
  jti?: string; type?: "development-disabled" | "approved-service"; scope?: "register-disabled" | "enable";
  paidCallsAllowed?: 0 | 1; model?: string; endpoint?: string; accountRef?: string; activityId?: string;
  priceRevision?: string; budget?: Record<string, unknown>; approval?: unknown;
  document?: string; evidence?: Record<string, unknown>; manifestOver?: Record<string, unknown>;
  identitiesDigest?: string; identities?: { owner?: Record<string, unknown>; member?: Record<string, unknown> };
  /** 按公司 proof-contract 规则派生摘要（去 digest 后 manifest 的 canonical sha256），并把批准 digest 机械对齐；调用方仍显式传全新批准任务。 */
  deriveDigest?: boolean;
} = {}): string {
  const ids = identities(tag);
  const model = overrides.model ?? "sensenova-6.8-flash-lite";
  const endpoint = overrides.endpoint ?? "https://token.sensenova.cn/v1";
  const accountRef = overrides.accountRef ?? "synthetic-existing-service";
  const priceRevision = overrides.priceRevision ?? "synthetic-unsupported";
  const document = overrides.document ?? evidenceDocument(tag, overrides.evidence);
  const documentHash = bytesHash(document);
  const manifestBody = {
    schemaVersion: 1, goalId: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, env: "production",
    activityId: overrides.activityId ?? `activity-${tag}`, workspaceSlug: "ui01", documentHash,
    service: { accountRef, endpoint, model, priceRevision },
    budget: { currency: "USD", totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true, ...overrides.budget },
    identities: [
      { alias: "LCA04_REMOVABLE", workspaceRole: "admin", billingRole: "owner" },
      { alias: "LCA04_MEMBER", workspaceRole: "participant", billingRole: "member" },
    ],
    ...overrides.manifestOver,
  };
  // 默认按公司规则派生摘要（与产品侧 renewalMatches 的复算互认）；manifestOver 可整体替换 body。
  // 旧用例沿用固定种子摘要（与旧 manifest 逐项比对的幂等/冲突语义不变）；deriveDigest 用于续期用例。
  const manifestWithoutDigest = { ...manifestBody };
  const derived = createHash("sha256").update(canonicalJson(manifestWithoutDigest)).digest("hex");
  const configurationDigest = overrides.deriveDigest ? derived : digest(`configuration:${tag}:jti-${tag}`);
  const manifest = { ...manifestBody, configurationDigest };
  const owner = { ...ids.owner, ...overrides.identities?.owner };
  const member = { ...ids.member, ...overrides.identities?.member };
  // 派生摘要时批准 digest 必须机械对齐新摘要（verifyCompanyProof 强制 approval.digest === configurationDigest）；
  // 显式传的 approval 仍保留调用方的任务/版本/审计字段，只对齐 digest，保证“新独立批准任务”可断言。
  const approvalInput = overrides.approval as { digest?: string } | null | undefined;
  const approval = overrides.deriveDigest && approvalInput && typeof approvalInput === "object"
    ? { ...approvalInput, digest: derived }
    : (overrides.approval ?? null);
  const payload = {
    contractVersion: 1, type: overrides.type ?? "development-disabled",
    paidCallsAllowed: overrides.paidCallsAllowed ?? 0, scope: overrides.scope ?? "register-disabled",
    project: COMPANY_PROOF_PROJECT, env: "production", goal: COMPANY_PROOF_GOAL,
    requestTask: `company-task-${tag}`,
    lease: { goal: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, role: "engineering", employee: "synthetic-employee", taskId: `company-task-${tag}`, delivery: `delivery-${tag}`, fence: 1 },
    approval, documentHash, manifest, configurationDigest,
    identities: [owner, member],
    identitiesDigest: overrides.identitiesDigest ?? digest(`identities:${tag}`),
    jti: overrides.jti ?? `jti-${tag}`, nonce: "abcdefghijklmnopqrstuvwx",
    iat: SECONDS, exp: SECONDS + 60,
    status: { path: "/internal-ai/status", bearer: "C".repeat(43) },
    iss: COMPANY_PROOF_ISSUER, aud: COMPANY_PROOF_AUDIENCE,
  };
  const head = { alg: "EdDSA", typ: COMPANY_PROOF_TYP, kid };
  const message = `${encode(head)}.${encode(payload)}`;
  return `${message}.${sign(null, Buffer.from(message), pair.privateKey).toString("base64url")}`;
}

const claimsOf = (jwt: string): CompanyProofClaims => verifyCompanyProof(jwt, NOW, anchor);

beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "internal-ai-registration-fork-"));
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer(); listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address(); if (!address || typeof address === "string") { listener.close(); reject(new Error("port unavailable")); return; }
      listener.close(() => resolve(address.port));
    });
  });
  endpoint = `ws://127.0.0.1:${port}`;
  child = Bun.spawn([binary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", `rocksdb:${join(directory, "data")}`], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 80; i++) {
    const probe = Bun.spawn([binary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) break;
    if (i === 79) throw new Error("company fork unavailable");
    await Bun.sleep(50);
  }
  db = new Surreal(); await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
  await db.query("DEFINE NAMESPACE IF NOT EXISTS registration_test;"); await db.use({ namespace: "registration_test" });
  await db.query("DEFINE DATABASE IF NOT EXISTS _system;"); await db.use({ namespace: "registration_test", database: "_system" });
  for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
    await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
  }
  registration = new InternalAiRegistration(async () => db!, { check: async () => {}, current: async () => {}, remember: () => {} });
  gate = new InternalAiGate(new InternalAiStore(async () => db!));
}, 30000);

afterAll(async () => {
  try { await db?.close(); } finally { if (child) { child.kill(); await child.exited; } if (directory) await rm(directory, { recursive: true, force: true }); }
});

function rows(result: unknown): Record<string, unknown>[] {
  const first: unknown = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first as Record<string, unknown>[] : first && typeof first === "object" ? [first as Record<string, unknown>] : [];
}

localTest("company proof registers a disabled activity with both frozen identities and no paid authorization", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "register";
  const summary = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "合成开发登记" });
  expect(summary.state).toBe("disabled");
  expect(summary.revision).toBe(1);
  expect(summary.proofType).toBe("development-disabled");
  expect(summary.paidCallsAllowed).toBe(0);
  expect(summary.model).toBe("sensenova-6.8-flash-lite");
  expect(summary.endpointHost).toBe("token.sensenova.cn");
  expect(summary.gaps).toContain("price-certificate");
  expect(summary.dataReady).toBe(false);
  expect(summary.identities.map(i => i.alias).sort()).toEqual(["LCA04_MEMBER", "LCA04_REMOVABLE"]);
  // 身份只以哈希落库：响应与库里都不出现 subject 原文。
  expect(JSON.stringify(summary)).not.toContain(`owner-${tag}`);
  expect(JSON.stringify(summary)).not.toContain(`member-${tag}`);
  const stored = await registration.identities(`activity-${tag}`);
  expect(JSON.stringify(stored)).not.toContain(`owner-${tag}`);
  expect(stored.map(i => i.identity_hash).sort()).toEqual([hash(`member-${tag}`, `ws_${tag}`), hash(`owner-${tag}`, `ws_${tag}`)].sort());
  // 活动先建即 disabled，且未获得任何付费授权字段。
  const activity = rows(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_activity", `activity-${tag}`) }))[0]!;
  expect(activity.enabled).toBe(false);
  expect(activity.service_approved).toBe(false);
  expect(activity.balance_nano_usd ?? null).toBe(null);
  expect(activity.price_revisions).toEqual([]);
  expect(activity.total_limit).toBe(1_000_000_000);
  // 未启用 + 无价目证书：门禁在内部 run 内不发预留。
  const scope = await gate.bind(`owner-${tag}`, `ws_${tag}`, "run-register", "key-register");
  expect(scope?.activity).toBe(`activity-${tag}`);
  await expect(gate.inRun(scope, () => gate.begin("proposal", "openai", "sensenova-6.8-flash-lite", "https://token.sensenova.cn/v1"))).rejects.toThrow();
});

localTest("replayed proof is idempotent, but a different digest under the same jti conflicts", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "idem";
  const first = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "首次登记" });
  const replay = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "重复投递" });
  expect(replay.idempotentReplay).toBe(true);
  expect(replay.revision).toBe(first.revision);
  const changedGrant: CompanyProofClaims = { ...claimsOf(proof(tag)), type: "approved-service", scope: "enable", paidCallsAllowed: 1,
    approval: { taskId: "synthetic-changed-approval", version: 1, action: "accept", auditId: "audit:changed", reviewer: "synthetic-reviewer", digest: first.configurationDigest } };
  await expect(registration.register({ claims: changedGrant, operator: "synthetic-operator", reason: "同jti篡改批准" })).rejects.toThrow(/同一证明标识已登记不同证据/);
  const clash = proof(tag, { evidence: { priceRevision: "synthetic-other" } });
  await expect(registration.register({ claims: claimsOf(clash), operator: "synthetic-operator", reason: "同标识不同证据" })).rejects.toThrow(/同一证明标识已登记不同证据/);
  expect((await registration.revisions(`activity-${tag}`)).length).toBe(1);
});

localTest("identity cannot be rebound to another activity and a revoked identity cannot come back", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "revoke";
  const bound = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "先正常绑定" });
  expect(bound.activity).toBe(`activity-${tag}`);
  await expect(registration.register({ claims: claimsOf(proof(tag, { activityId: `other-${tag}`, jti: "other-jti" })), operator: "synthetic-operator", reason: "改绑活动" })).rejects.toThrow(/登记事务/);
  const revoked = await registration.revokeIdentity({ alias: "LCA04_MEMBER", activity: `activity-${tag}`, operator: "synthetic-operator", reason: "合成撤销" });
  expect(revoked.revoked).toBe(true);
  expect(revoked.identityHash).toBe(hash(`member-${tag}`, `ws_${tag}`));
  expect((await registration.revokeIdentity({ alias: "LCA04_MEMBER", activity: `activity-${tag}`, operator: "synthetic-operator", reason: "重复撤销" })).revoked).toBe(true);
  await expect(registration.register({ claims: claimsOf(proof(tag, { jti: "after-revoke" })), operator: "synthetic-operator", reason: "撤销后重新登记" })).rejects.toThrow(/登记事务/);
  // 撤销后门禁拒绝：不降级为非计量路径。
  await expect(gate.bind(`member-${tag}`, `ws_${tag}`, "run-after-revoke")).rejects.toThrow(/revoked/);
  // 撤销只置标记：identity 与 binding 行都还在。
  expect((await registration.identities(`activity-${tag}`)).length).toBe(2);
  expect(rows(await db.query("SELECT * FROM internal_ai_binding WHERE identity_hash = $i", { i: hash(`member-${tag}`, `ws_${tag}`) })).length).toBe(1);
});

localTest("evidence document must hash to the company-signed documentHash; operator-typed values never pass", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "evidence";
  const target = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "为证据登记" });
  // 自填一份"看起来已批准"的文档：字节对不上公司哈希，必须拒绝。
  const forged = evidenceDocument(tag, { type: "reviewed-service", balanceNanoUsd: 1, serviceApproved: true });
  await expect(registration.submitEvidence({ activity: target.activity, revision: target.revision, document: forged, operator: "synthetic-operator", reason: "自填证据" })).rejects.toThrow(/文档摘要不一致/);
  // 字节正确但字段与登记的服务标识不一致：拒绝。
  const right = evidenceDocument(tag);
  const wrongService = JSON.stringify({ ...JSON.parse(right), model: "gpt-4o-mini-2024-07-18" });
  await expect(registration.submitEvidence({ activity: target.activity, revision: target.revision, document: wrongService, operator: "synthetic-operator", reason: "错模型" })).rejects.toThrow(/文档摘要不一致/);
  // development-disabled 文档本体可登记，但 enable 仍 fail-closed。
  const submitted = await registration.submitEvidence({ activity: target.activity, revision: target.revision, document: right, operator: "synthetic-operator", reason: "提交合成开发证据" });
  expect(submitted.state).toBe("disabled");
  expect(submitted.balanceNanoUsd).toBe(0);
  expect(submitted.serviceApproved).toBe(false);
  expect(submitted.gaps).toContain("approved-service-evidence");
  expect(submitted.gaps).toContain("balance-positive");
  expect(submitted.gaps).toContain("service-approved");
  // 证据正文绝不落库：连原始 JSON 串都不能出现在库里。
  expect(JSON.stringify(await registration.revisions(target.activity))).not.toContain(right);
  expect(JSON.stringify(await registration.revisions(target.activity))).not.toContain(forged);
});

localTest("enable stays fail-closed for expired evidence, zero balance, illegal fields, wrong host/model and missing certificate", async () => {
  if (!db) throw new Error("fixture unavailable");
  const runtime = { provider: "openai", model: "sensenova-6.8-flash-lite", endpoint: "https://token.sensenova.cn/v1" };
  const approval = { taskId: "synthetic-approval", version: 2, action: "accept", auditId: "audit:enable", reviewer: "synthetic-reviewer", digest: "" };
  /** 每个变体一份独立证明 + 独立活动：证明签的就是即将提交的那一份文档。 */
  const enroll = async (tag: string, over: Record<string, unknown>) => {
    const document = evidenceDocument(tag, { type: "reviewed-service", ...over });
    const registered = await registration.register({ claims: claimsOf(proof(tag, { type: "approved-service", scope: "enable", paidCallsAllowed: 1, document, approval: { ...approval, digest: digest(`configuration:${tag}:jti-${tag}`) } })), operator: "synthetic-operator", reason: "受审登记" });
    return registration.submitEvidence({ activity: registered.activity, revision: registered.revision, document, operator: "synthetic-operator", reason: "提交证据" });
  };
  // 证据过期 → evidence-not-expired。
  const expired = await enroll("expired", { balanceNanoUsd: 1_000_000_000, expiresAt: new Date(NOW - 1).toISOString(), serviceApproved: true });
  expect(await registration.gapsFor((await registration.revision(expired.activity, expired.revision))!, runtime)).toContain("evidence-not-expired");
  await expect(registration.enable({ activity: expired.activity, revision: expired.revision, operator: "synthetic-operator", reason: "启用过期证据", runtime })).rejects.toThrow(/启用证据不足/);
  // 余额为 0 → balance-positive。
  const zero = await enroll("zero", { balanceNanoUsd: 0, serviceApproved: true });
  expect(await registration.gapsFor((await registration.revision(zero.activity, zero.revision))!, runtime)).toContain("balance-positive");
  // 未批准服务 → service-approved。
  const unapproved = await enroll("unapproved", { balanceNanoUsd: 1_000_000_000, serviceApproved: false });
  expect(await registration.gapsFor((await registration.revision(unapproved.activity, unapproved.revision))!, runtime)).toContain("service-approved");
  // 非 USD / 未停自动充值 / 负余额 / 非法时间 / 未知字段：schema 层就拒绝，根本进不到 revision。
  const strict = await enroll("strict", { balanceNanoUsd: 1_000_000_000, serviceApproved: true });
  for (const over of [{ currency: "CNY" }, { autoTopupDisabled: false }, { serviceApproved: true, balanceNanoUsd: -1 }, { sampledAt: "not-a-time" }, { unknownField: 1 }, { type: "other" }]) {
    await expect(registration.submitEvidence({ activity: strict.activity, revision: strict.revision - 1, document: evidenceDocument("strict", { type: "reviewed-service", ...over }), operator: "synthetic-operator", reason: "非法字段" })).rejects.toThrow();
  }
  // 完整受审证据但 SenseNova 没有价目证书 → price-certificate。
  const complete = await enroll("complete", { balanceNanoUsd: 1_000_000_000, serviceApproved: true });
  const gaps = await registration.gapsFor((await registration.revision(complete.activity, complete.revision))!, runtime);
  expect(gaps).toEqual(["price-certificate"]);
  await expect(registration.enable({ activity: complete.activity, revision: complete.revision, operator: "synthetic-operator", reason: "缺价目启用", runtime })).rejects.toThrow(/启用证据不足/);
  // 换成 OpenAI 模型/host：与当前生产连接不一致，仍然拒绝（不得替换模型）。
  await expect(registration.enable({ activity: complete.activity, revision: complete.revision, operator: "synthetic-operator", reason: "换模型", runtime: { provider: "openai", model: "gpt-4o-mini-2024-07-18", endpoint: "https://api.openai.com/v1" } })).rejects.toThrow(/启用证据不足/);
  await expect(registration.enable({ activity: complete.activity, revision: complete.revision, operator: "synthetic-operator", reason: "Jev缺独立证据", runtime: { ...runtime, jevEnabled: true, jevModel: "jev-1.13.0" } })).rejects.toThrow(/启用证据不足/);
  // 生产连接未配置：同样拒绝。
  await expect(registration.enable({ activity: complete.activity, revision: complete.revision, operator: "synthetic-operator", reason: "无生产连接", runtime: {} })).rejects.toThrow(/启用证据不足/);
});

localTest("a fully reviewed openai activity enables, keeps its ledger, and can be disabled without losing history", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS[0]!;
  const tag = "openai";
  const activityId = `activity-${tag}`;
  const endpoint = `https://${tariff.host}/v1`;
  const document = JSON.stringify({
    schemaVersion: 1, type: "reviewed-service", accountRef: "synthetic-openai-account", endpoint,
    model: tariff.model, priceRevision: tariff.revision, currency: "USD", balanceNanoUsd: 2_000_000_000,
    sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(),
    autoTopupDisabled: true, serviceApproved: true,
  });
  const documentHash = bytesHash(document);
  const registered = await registration.register({ claims: claimsOf(proof(tag, {
    type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document,
    model: tariff.model, endpoint, accountRef: "synthetic-openai-account", priceRevision: tariff.revision,
    budget: { totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: worstCost(tariff), maxAttempts: 30, autoTopupDisabled: true },
    approval: { taskId: "synthetic-approval-task", version: 4, action: "accept", auditId: "audit:openai", reviewer: "synthetic-reviewer", digest: digest(`configuration:${tag}:jti-${tag}`) },
  })), operator: "synthetic-operator", reason: "OpenAI 受审登记" });
  expect(registered.proofType).toBe("approved-service");
  expect(registered.approval?.taskId).toBe("synthetic-approval-task");
  const submitted = await registration.submitEvidence({ activity: activityId, revision: registered.revision, document, operator: "synthetic-operator", reason: "提交受审余额证据" });
  expect(submitted.gaps).toEqual([]);
  const enabled = await registration.enable({ activity: activityId, revision: submitted.revision, operator: "synthetic-operator", reason: "显式启用", runtime: { provider: tariff.provider, model: tariff.model, endpoint } });
  expect(enabled.state).toBe("enabled");
  expect(enabled.dataReady).toBe(true);
  expect(enabled.priceRevision).toBe(tariff.revision);
  const activity = rows(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_activity", activityId) }))[0]!;
  expect(activity.enabled).toBe(true);
  expect(activity.service_approved).toBe(true);
  expect(activity.balance_currency).toBe("USD");
  expect(activity.balance_source).toBe(`reviewed-document:${documentHash}`);
  expect(activity.balance_evidence_hash).toBe(documentHash);
  expect(activity.price_revisions).toEqual([tariff.revision]);
  // 走一遍真实门禁：绑定身份 + 在内部 run 内预留一笔，再禁用，账本不得被重置。
  const scope = await gate.bind(`owner-${tag}`, `ws_${tag}`, "run-openai", "key-openai");
  expect(scope?.activity).toBe(activityId);
  await gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint));
  const before = rows(await db.query("SELECT reserved, spent, attempts FROM ONLY $id", { id: new RecordId("internal_ai_activity", activityId) }))[0]!;
  const disabled = await registration.disable({ activity: activityId, operator: "synthetic-operator", reason: "合成禁用" });
  expect(disabled.state).toBe("disabled");
  const after = rows(await db.query("SELECT enabled, reserved, spent, attempts FROM ONLY $id", { id: new RecordId("internal_ai_activity", activityId) }))[0]!;
  expect(after.enabled).toBe(false);
  expect(after.reserved).toBe(before.reserved);
  expect(after.spent).toBe(before.spent);
  expect(after.attempts).toBe(before.attempts);
  // 禁用后门禁拒绝新的预留。
  await expect(gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint))).rejects.toThrow();
  // 旧 revision 不可变：enable/disable 只新增，不改写。
  const revisions = await registration.revisions(activityId);
  expect(revisions.map(r => r.revision)).toEqual([1, 2, 3, 4]);
  expect(revisions.map(r => r.state)).toEqual(["disabled", "disabled", "enabled", "disabled"]);
  expect(revisions[2]!.operator).toBe("synthetic-operator");
  expect(revisions[3]!.before?.enabled).toBe(true);
  expect(revisions[3]!.after?.enabled).toBe(false);
  // 派生 revision 不带 proof_jti，只带 source_jti 追溯来源。
  expect(revisions[2]!.proof_jti ?? null).toBe(null);
  expect(revisions[2]!.source_jti).toBe(`jti-${tag}`);
});

localTest("a reviewed token-plan evidence enables the zero-rate certificate and settles at zero cost without a USD balance", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "tokenplan";
  const activityId = `activity-${tag}`;
  const endpoint = `https://${tariff.host}/v1`;
  const document = tokenPlanDocument();
  const documentHash = bytesHash(document);
  const registered = await registration.register({ claims: claimsOf(proof(tag, {
    type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document,
    model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
    approval: { taskId: "synthetic-approval-task", version: 3, action: "accept", auditId: "audit:tokenplan", reviewer: "synthetic-reviewer", digest: digest(`configuration:${tag}:jti-${tag}`) },
  })), operator: "synthetic-operator", reason: "SenseNova Token Plan 受审登记" });
  expect(registered.proofType).toBe("approved-service");
  const submitted = await registration.submitEvidence({ activity: activityId, revision: registered.revision, document, operator: "synthetic-operator", reason: "提交配额型受审证据" });
  expect(submitted.evidenceKind).toBe("reviewed-token-plan");
  expect(submitted.currency).toBeNull();
  expect(submitted.balanceNanoUsd).toBeNull();
  expect(submitted.balanceSource).toBe(`token-plan:${documentHash}`);
  expect(submitted.quotaUnit).toBe("points");
  expect(submitted.quotaAmount).toBe(60000);
  expect(submitted.noPaymentInstrument).toBeNull();
  expect(submitted.accountPlanType).toBe(TOKEN_PLAN_PLAN_TYPE_FREE);
  expect(submitted.gaps).toEqual([]);
  await expect(registration.enable({ activity: activityId, revision: submitted.revision, measurementCycle: true, operator: "synthetic-operator", reason: "错误workspace不可分配测量周期", runtime: { provider: tariff.provider, model: tariff.model, endpoint } })).rejects.toThrow("指定复测 workspace");
  const enabled = await registration.enable({ activity: activityId, revision: submitted.revision, operator: "synthetic-operator", reason: "显式启用配额型活动", runtime: { provider: tariff.provider, model: tariff.model, endpoint } });
  expect(enabled.state).toBe("enabled");
  expect(enabled.dataReady).toBe(true);
  const activity = rows(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_activity", activityId) }))[0]!;
  expect(activity.enabled).toBe(true);
  expect(activity.evidence_kind).toBe("reviewed-token-plan");
  expect(activity.balance_nano_usd ?? null).toBe(null);
  expect(activity.balance_currency ?? null).toBe(null);
  expect(activity.balance_source).toBe(`token-plan:${documentHash}`);
  expect(activity.quota_amount).toBe(60000);
  expect(activity.quota_window_seconds).toBe(18000);
  expect(activity.no_payment_instrument ?? null).toBe(null);
  expect(activity.account_plan_type).toBe(TOKEN_PLAN_PLAN_TYPE_FREE);
  expect(activity.price_revisions).toEqual([tariff.revision]);
  // 零费率证书走同一门禁：预留 0、按实际 usage 结算 0，账本仍是 nanoUSD。
  const scope = await gate.bind(`owner-${tag}`, `ws_${tag}`, "run-tokenplan", "key-tokenplan");
  expect(scope?.activity).toBe(activityId);
  const ticket = await gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint));
  expect(ticket?.tariff.revision).toBe(tariff.revision);
  await gate.inRun(scope, () => gate.finish(ticket, { inputTokens: 2000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null }, tariff.model, "synthetic-request", false));
  const attempt = (await gate.store.page(activityId))[0]!;
  expect(attempt.state).toBe("settled");
  expect(attempt.cost).toBe(0);
  expect(attempt.reserved).toBe(0);
  expect(attempt.currency).toBe("USD");
  const ledger = rows(await db.query("SELECT reserved, spent, attempts FROM ONLY $id", { id: new RecordId("internal_ai_activity", activityId) }))[0]!;
  expect(ledger.spent).toBe(0);
  expect(ledger.reserved).toBe(0);
  expect(ledger.attempts).toBe(1);
});

localTest("token-plan evidence stays fail-closed: schema, quota gaps, wrong runtime and unapproved proof all deny enable", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const runtime = { provider: "openai", model: tariff.model, endpoint: `https://${tariff.host}/v1` };
  const approval = (tag: string) => ({ taskId: "synthetic-approval", version: 1, action: "accept", auditId: `audit:${tag}`, reviewer: "synthetic-reviewer", digest: digest(`configuration:${tag}:jti-${tag}`) });
  const service = { model: tariff.model, endpoint: runtime.endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision };
  const registerWith = async (tag: string, document: string, approved = true) =>
    registration.register({ claims: claimsOf(proof(tag, approved
      ? { type: "approved-service", scope: "enable", paidCallsAllowed: 1, document, approval: approval(tag), ...service }
      : { document, ...service })), operator: "synthetic-operator", reason: "配额型登记" });
  const enroll = async (tag: string, over: Record<string, unknown>, approved = true) => {
    const document = tokenPlanDocument(over);
    const registered = await registerWith(tag, document, approved);
    return registration.submitEvidence({ activity: registered.activity, revision: registered.revision, document, operator: "synthetic-operator", reason: "提交配额证据" });
  };
  // schema 层拒绝：每种非法文档都经公司证明哈希绑定后提交，仍被严格契约拒绝。
  for (const [index, over] of [
    { quotaAmount: 0 }, { quotaAmount: -1 }, { planSourceUrl: "http://www.sensenova.cn/token-plan" },
    { planSourceUrl: "https://www.sensenova.cn/token-plan?x=1" }, { accountPlanType: "TOKEN_PLAN_PLAN_TYPE_PAID" },
    { accountPlanType: "free" }, { accountPlanType: undefined }, { schemaVersion: 1 },
    { noPaymentInstrument: true }, { autoTopupDisabled: true },
    { quotaUnit: "usd" }, { balanceNanoUsd: 1, currency: "USD" }, { unknownField: 1 }, { type: "reviewed-service" },
  ].entries()) {
    const tag = `tpstrict${index}`, document = tokenPlanDocument(over);
    const registered = await registerWith(tag, document);
    await expect(registration.submitEvidence({ activity: registered.activity, revision: registered.revision, document, operator: "synthetic-operator", reason: "非法配额字段" })).rejects.toThrow(/字段不合法/);
    expect((await registration.revisions(registered.activity)).length).toBe(1);
  }
  // 配额耗尽（remaining=0）→ quota-positive，enable 拒绝。
  const exhausted = await enroll("tpexhausted", { quotaRemaining: 0 });
  expect(await registration.gapsFor((await registration.revision(exhausted.activity, exhausted.revision))!, runtime)).toContain("quota-positive");
  await expect(registration.enable({ activity: exhausted.activity, revision: exhausted.revision, operator: "synthetic-operator", reason: "配额耗尽启用", runtime })).rejects.toThrow(/启用证据不足/);
  // remaining 可空（官方只读接口未核定时写 null）：不产生 quota-positive。
  const unknownRemaining = await enroll("tpunknownremaining", { quotaRemaining: null });
  expect(await registration.gapsFor((await registration.revision(unknownRemaining.activity, unknownRemaining.revision))!, runtime)).toEqual([]);
  // 服务未批准 → service-approved；采样在未来 → balance-sampled-at；过期 → evidence-not-expired。
  const unapproved = await enroll("tpunapproved", { serviceApproved: false });
  expect(await registration.gapsFor((await registration.revision(unapproved.activity, unapproved.revision))!, runtime)).toContain("service-approved");
  const stale = await enroll("tpstale", { expiresAt: new Date(NOW - 1).toISOString() });
  expect(await registration.gapsFor((await registration.revision(stale.activity, stale.revision))!, runtime)).toContain("evidence-not-expired");
  // runtime 与证书不一致 → price-certificate。
  const mismatched = await enroll("tpmismatch", {});
  for (const bad of [
    { ...runtime, model: "sensenova-6.8-flash" },
    { ...runtime, provider: "sensenova" },
    { ...runtime, endpoint: "https://api.sensenova.cn/v1" },
    { ...runtime, jevEnabled: true, jevModel: "jev-1.13.0" },
  ]) {
    await expect(registration.enable({ activity: mismatched.activity, revision: mismatched.revision, operator: "synthetic-operator", reason: "错配启用", runtime: bad })).rejects.toThrow(/启用证据不足/);
  }
  // development-disabled 证明可以登记配额文档（类型不受限），但缺独立批准永远不可启用。
  const devOnly = await enroll("tpdevonly", {}, false);
  expect(devOnly.gaps).toContain("approved-service-evidence");
  await expect(registration.enable({ activity: devOnly.activity, revision: devOnly.revision, operator: "synthetic-operator", reason: "开发证明启用", runtime })).rejects.toThrow(/启用证据不足/);
});

localTest("shared target ledger is never reset by re-registration, evidence or disable", async () => {
  if (!db) throw new Error("fixture unavailable");
  const target = () => db!.query("SELECT reserved, spent, attempts FROM ONLY $id", { id: new RecordId("internal_ai_target", "2e2a6e41c1193595") });
  const before = rows(await target())[0]!;
  await registration.disable({ activity: "activity-openai", operator: "synthetic-operator", reason: "再次禁用" });
  const after = rows(await target())[0]!;
  expect(after.reserved).toBe(before.reserved);
  expect(after.spent).toBe(before.spent);
  expect(after.attempts).toBe(before.attempts);
});

localTest("reason is mandatory and bounded; unknown activity revisions are rejected", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "reason";
  // claimsOf(proof(...)) 必须包在 async 里，否则验签异常会在 expect 之前就抛出。
  const enroll = (reason: string, jti: string) => (async () => registration.register({ claims: claimsOf(proof(tag, { jti })), operator: "synthetic-operator", reason }))();
  for (const reason of ["   ", "x".repeat(501), "bad\nreason"]) {
    await expect(enroll(reason, `jti-${tag}-${reason.length}`)).rejects.toThrow(/操作原因/);
  }
  await expect(enroll("合法原因", `jti-${tag}-ok`)).resolves.toMatchObject({ state: "disabled" });
  await expect((async () => registration.enable({ activity: "missing-activity", revision: 1, operator: "synthetic-operator", reason: "不存在", runtime: {} }))()).rejects.toThrow(/登记版本不存在/);
  await expect((async () => registration.disable({ activity: "missing-activity", operator: "synthetic-operator", reason: "不存在" }))()).rejects.toThrow(/尚未受审配置/);
  await expect((async () => registration.submitEvidence({ activity: "missing-activity", revision: 1, document: evidenceDocument(tag), operator: "synthetic-operator", reason: "不存在" }))()).rejects.toThrow(/登记版本不存在/);
  // manifest 里的活动标识不合法：验签层就拒绝，根本进不到登记。
  await expect((async () => registration.register({ claims: claimsOf(proof(tag, { jti: "jti-bad-id", activityId: "bad id with spaces" })), operator: "synthetic-operator", reason: "非法活动标识" }))()).rejects.toThrow(/声明不合法/);
});

localTest("registration races cannot leave partial activities/bindings; history rejects mutation", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "race";
  const inputs = ["a", "b"].map(key => ({ claims: claimsOf(proof(tag, { activityId: `race-${key}`, jti: `jti-race-${key}` })), operator: "synthetic-operator", reason: "并发绑定" }));
  const results = await Promise.allSettled(inputs.map(i => registration.register(i)));
  expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
  expect((await registration.identities("race-a")).length + (await registration.identities("race-b")).length).toBe(2);
  const rejectedIndex = results.findIndex(r => r.status === "rejected");
  const missing = inputs[rejectedIndex]!.claims.manifest.activityId;
  expect((await registration.revisions(missing)).length).toBe(0);
  expect(rows(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_activity", missing) })).length).toBe(0);
  const saved = inputs[results.findIndex(r => r.status === "fulfilled")]!.claims.manifest.activityId;
  await expect((async () => db!.query("UPDATE internal_ai_revision SET reason = 'tampered' WHERE activity = $activity", { activity: saved }))()).rejects.toThrow();
  expect((await registration.revisions(saved))[0]!.reason).toBe("并发绑定");
});

localTest("enable cannot resurrect disabled old evidence; refresh and revoke preserve counters", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "preserve";
  const c = claimsOf(proof(tag));
  const first = await registration.register({ claims: c, operator: "synthetic-operator", reason: "首次登记" });
  await db.query("UPDATE ONLY $id SET spent = 7, reserved = 11, attempts = 3", { id: new RecordId("internal_ai_activity", first.activity) });
  const replay = await registration.register({ claims: claimsOf(proof(tag, { jti: "preserve-refresh" })), operator: "synthetic-operator", reason: "刷新证明" });
  expect(replay.after).toMatchObject({ spent: 7, reserved: 11, attempts: 3 });
  const disabled = await registration.disable({ activity: first.activity, operator: "synthetic-operator", reason: "禁用" });
  await expect(registration.enable({ activity: first.activity, revision: replay.revision, operator: "synthetic-operator", reason: "旧版本启用", runtime: {} })).rejects.toThrow(/旧证据/);
  await registration.revokeIdentity({ activity: first.activity, alias: "LCA04_REMOVABLE", operator: "synthetic-operator", reason: "撤销" });
  const latest = (await registration.revisions(first.activity)).at(-1)!;
  expect(latest.revision).toBe(disabled.revision + 1);
  expect(latest.after).toMatchObject({ spent: 7, reserved: 11, attempts: 3, enabled: false });
});

localTest("missing or withdrawn company status denies the controlled chain (register/evidence/enable)", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "status";
  const unavailable = new InternalAiRegistration(async () => db!);
  await expect(unavailable.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "状态地址未配置" })).rejects.toThrow(/当前状态/);
  expect((await registration.revisions(`activity-${tag}`)).length).toBe(0);
  let valid = true;
  const assert = async () => { if (!valid) throw new Error("synthetic-status-revoked"); };
  const service = new InternalAiRegistration(async () => db!, { check: assert, current: assert, remember: () => {} });
  await service.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "状态仍有效" });
  valid = false;
  await expect(service.submitEvidence({ activity: `activity-${tag}`, revision: 1, document: evidenceDocument(tag), operator: "synthetic-operator", reason: "撤回后补证" })).rejects.toThrow(/revoked/);
  // 状态不可达/无效只在受控链路 fail-closed；用户 attempt 的锚定见下方解耦用例。
});


localTest("normal identity projection cannot swap roles or billing accounts", async () => {
  const valid = claimsOf(proof("roles"));
  const [owner, member] = valid.identities;
  for (const identities of [[member, owner], [owner, { ...member, billingAccountRef: "different-account" }], [owner, { ...member, subject: owner.subject }]] as const) {
    await expect(registration.register({ claims: { ...valid, identities: [identities[0], identities[1]] }, operator: "synthetic-operator", reason: "身份配对冲突" })).rejects.toThrow(/身份角色/);
  }
  expect((await registration.revisions(valid.manifest.activityId)).length).toBe(0);
});


localTest("hash-bound illegal currency, unknown FX/plan, missing balance and topup fields cannot become evidence", async () => {
  const cases: Record<string, unknown>[] = [{ currency: "CNY" }, { fx: { rate: 1 } }, { tokenPlan: true }, { balanceNanoUsd: undefined }, { autoTopupDisabled: false }, { sampledAt: "invalid" }];
  for (let index = 0; index < cases.length; index++) {
    const tag = `strict_${index}`, document = evidenceDocument(tag, cases[index]);
    const row = await registration.register({ claims: claimsOf(proof(tag, { document })), operator: "synthetic-operator", reason: "真实字节哈希合成反例登记" });
    await expect(registration.submitEvidence({ activity: row.activity, revision: row.revision, document, operator: "synthetic-operator", reason: "非法资料" })).rejects.toThrow(/字段不合法/);
    expect((await registration.revisions(row.activity)).length).toBe(1);
  }
});

localTest("development-disabled first registration writes exactly one disabled revision and never requires a USD currency", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tag = "devfirst";
  const summary = await registration.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "开发禁用首登" });
  expect(summary.state).toBe("disabled");
  expect(summary.revision).toBe(1);
  expect(summary.currency).toBeNull();
  const revisions = await registration.revisions(`activity-${tag}`);
  // 恰好一条 disabled revision；036 放宽后 currency 落库为 NONE，不强制 USD。
  expect(revisions.map(r => r.state)).toEqual(["disabled"]);
  const stored = rows(await db.query("SELECT currency FROM ONLY $id", { id: new RecordId("internal_ai_revision", `activity-${tag}:1`) }))[0]!;
  expect(stored.currency ?? null).toBe(null);
});

localTest("pre-commit store failures collapse to 503 company-proof-store-unavailable and write nothing", async () => {
  if (!db) throw new Error("fixture unavailable");
  const status = { check: async () => {}, current: async () => {}, remember: () => {} };
  // 提交前的三次读查询（proof_jti 幂等查重、latest、identities）各自独立故障都必须收成 503。
  const markers = ["proof_jti = $jti", "ORDER BY revision", "internal_ai_identity"];
  for (const [index, marker] of markers.entries()) {
    const tag = `store503_${index}`;
    const realDb = db;
    const degraded = new InternalAiRegistration(async () => ({
      query: (sql: string, vars?: Record<string, unknown>) => sql.includes(marker)
        ? Promise.reject(new TypeError(`synthetic failure near ${marker}`))
        : realDb.query(sql, vars),
    }), status);
    const error = await degraded.register({ claims: claimsOf(proof(tag)), operator: "synthetic-operator", reason: "存储故障登记" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(503);
    expect(http.code).toBe("company-proof-store-unavailable");
    // 消息只含错误类型名：不带 SQL、证明、bearer 或 subject。
    expect(http.message).toBe("公司证明存储不可用（TypeError）");
    expect(JSON.stringify(http)).not.toContain(marker);
    expect(JSON.stringify(http)).not.toContain(`owner-${tag}`);
    expect(JSON.stringify(http)).not.toContain("C".repeat(43));
    expect(await registration.revisions(`activity-${tag}`)).toEqual([]);
  }
  // HttpError 原样透传，不被收成 503。
  const passthrough = new InternalAiRegistration(async () => ({
    query: () => Promise.reject(new HttpError(409, "synthetic-preserved", "原样抛出")),
  }), status);
  const preserved = await passthrough.register({ claims: claimsOf(proof("store503_keep")), operator: "synthetic-operator", reason: "冲突透传" }).catch((e: unknown) => e);
  expect(preserved).toBeInstanceOf(HttpError);
  expect((preserved as HttpError).code).toBe("synthetic-preserved");
  expect((preserved as HttpError).status).toBe(409);
});

localTest("enabled activity serves user attempts after the operator proof window; controlled chain stays fail-closed", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "decouple";
  const activityId = `activity-${tag}`;
  const endpoint = `https://${tariff.host}/v1`;
  const document = tokenPlanDocument();
  // 可变状态桩：true=投递会话仍有效，false=证明窗口过期/撤回（公司侧此刻必回 valid=false）。
  let revoked = false;
  const assert = async () => { if (revoked) throw new Error("synthetic-status-revoked"); };
  const service = new InternalAiRegistration(async () => db!, { check: assert, current: assert, remember: () => {} });
  const registered = await service.register({ claims: claimsOf(proof(tag, {
    type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document,
    model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
    approval: { taskId: "synthetic-approval-task", version: 6, action: "accept", auditId: "audit:decouple", reviewer: "synthetic-reviewer", digest: digest(`configuration:${tag}:jti-${tag}`) },
  })), operator: "synthetic-operator", reason: "解耦受审登记" });
  const submitted = await service.submitEvidence({ activity: activityId, revision: registered.revision, document, operator: "synthetic-operator", reason: "提交配额证据" });
  const enabled = await service.enable({ activity: activityId, revision: submitted.revision, operator: "synthetic-operator", reason: "显式启用", runtime: { provider: tariff.provider, model: tariff.model, endpoint } });
  expect(enabled.state).toBe("enabled");
  // 默认接线形状：gate 的 assertCurrent 读受审账本，不请求公司状态。
  const wiredGate = new InternalAiGate(new InternalAiStore(async () => db!), activity => service.assertCurrent(activity));
  const scope = await wiredGate.bind(`owner-${tag}`, `ws_${tag}`, "run-decouple", "key-decouple");
  expect(scope?.activity).toBe(activityId);
  // 模拟 >300s：活动行的投递证明窗口拨到过去，公司状态会话终结（撤回/租约终结同型）。
  await db.query("UPDATE ONLY $id SET proof_expires_at = 1", { id: new RecordId("internal_ai_activity", activityId) });
  revoked = true;
  // >300s 后无人工重刷仍可调用：用户 attempt 照常预留（零费率证书预留 0）并结算。
  const ticket = await wiredGate.inRun(scope, () => wiredGate.begin("proposal", tariff.provider, tariff.model, endpoint));
  expect(ticket?.tariff.revision).toBe(tariff.revision);
  await wiredGate.inRun(scope, () => wiredGate.finish(ticket, { inputTokens: 100, outputTokens: 10, cachedInputTokens: null, reasoningTokens: null }, tariff.model, "synthetic-request", false));
  expect((await wiredGate.store.page(activityId))[0]?.state).toBe("settled");
  // disable 后立即拒绝。
  const disabled = await service.disable({ activity: activityId, operator: "synthetic-operator", reason: "禁用" });
  await expect(wiredGate.inRun(scope, () => wiredGate.begin("proposal", tariff.provider, tariff.model, endpoint))).rejects.toThrow();
  // 受控链路 fail-closed：状态撤回后 enable 立即拒绝，已吊销会话不能复活同一证据。
  await expect(service.enable({ activity: activityId, revision: disabled.revision, operator: "synthetic-operator", reason: "撤回后启用", runtime: { provider: tariff.provider, model: tariff.model, endpoint } })).rejects.toThrow(/revoked/);
  // 绑定撤销后立即拒绝：换 run/key 也一样，持久标记不复活。
  await service.revokeIdentity({ activity: activityId, alias: "LCA04_MEMBER", operator: "synthetic-operator", reason: "撤销成员" });
  await expect(wiredGate.bind(`member-${tag}`, `ws_${tag}`, "run-after-revoke", "key-after-revoke")).rejects.toThrow(/revoked/);
});

localTest("one approved measurement cycle preserves 30 historical attempts and shares a nonresettable zero-rate budget", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "measurement", activityId = `activity-${tag}`, endpoint = `https://${tariff.host}/v1`;
  const runtime = { provider: tariff.provider, model: tariff.model, endpoint };
  await db.query("DEFINE DATABASE IF NOT EXISTS measurement_test;");
  await db.use({ namespace: "registration_test", database: "measurement_test" });
  for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
    await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
  }
  const document = tokenPlanDocument();
  const registered = await registration.register({ claims: claimsOf(proof(tag, {
    type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document,
    model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
    approval: { taskId: "synthetic-approval-task", version: 3, action: "accept", auditId: "audit:measurement", reviewer: "synthetic-reviewer", digest: digest(`configuration:${tag}:jti-${tag}`) },
  })), operator: "synthetic-operator", reason: "受审测量登记" });
  const submitted = await registration.submitEvidence({ activity: activityId, revision: registered.revision, document, operator: "synthetic-operator", reason: "真实字节哈希的合成证据" });
  let current = await registration.enable({ activity: activityId, revision: submitted.revision, operator: "synthetic-operator", reason: "旧周期启用", runtime });
  // 独立数据库中的 30 次合成传输历史；不冒充生产调用。
  const scope = await gate.bind(`owner-${tag}`, MEASUREMENT_DATABASE, "history", "history-key");
  if (!scope) throw new Error("missing bound fixture");
  for (let i = 0; i < 30; i++) {
    const ticket = await gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint));
    await gate.finish(ticket, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, tariff.model, `synthetic-old-${i}`, false);
  }
  const old = await gate.store.page(activityId);
  const target = await gate.store.target();
  expect(target.attempts).toBe(30);
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  const disabled = await registration.disable({ activity: activityId, operator: "synthetic-operator", reason: "开启新受限周期前禁用" });
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  current = await registration.enable({ activity: activityId, revision: disabled.revision, measurementCycle: true, operator: "synthetic-operator", reason: "GM批准的新受限周期", runtime });
  expect(current.state).toBe("enabled");
  expect((await gate.store.measurementCycle())?.attempt_limit).toBe(30);
  // 合成故障注入：证据过期、hash 改变、身份撤销都不能消耗本周期。
  const activityRecord = new RecordId("internal_ai_activity", activityId);
  await db.query('UPDATE ONLY $id SET evidence_expires_at = "2000-01-01T00:00:00Z"', { id: activityRecord });
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  await db.query('UPDATE ONLY $id SET evidence_expires_at = $expires, balance_evidence_hash = $hash', { id: activityRecord, expires: current.expiresAt, hash: "0".repeat(64) });
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  await db.query('UPDATE ONLY $id SET balance_evidence_hash = $hash', { id: activityRecord, hash: bytesHash(document) });
  await gate.store.revoke(`owner-${tag}`, MEASUREMENT_DATABASE);
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  // 仅隔离测试 fixture 恢复；生产撤销不可按此方式恢复。
  await db.query('UPDATE internal_ai_binding SET revoked = false WHERE identity_hash = $identity', { identity: hash(`owner-${tag}`, MEASUREMENT_DATABASE) });
  expect((await gate.store.measurementCycle())?.attempts).toBe(0);
  const unbound = { ...scope, runHash: hash("unbound-measurement") };
  await expect(gate.store.reserve(unbound, "proposal", tariff, 0)).rejects.toThrow();
  await expect(gate.store.reserve(scope, "proposal", TARIFFS[0]!, worstCost(TARIFFS[0]!))).rejects.toThrow();
  const attempts: PromiseSettledResult<Awaited<ReturnType<InternalAiStore["reserve"]>>>[] = [];
  for (let batch = 0; batch < 7; batch++) attempts.push(...await Promise.allSettled(Array.from({ length: 5 }, () => gate.store.reserve(scope, "proposal", tariff, 0))));
  const admitted = attempts.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  expect(admitted.length).toBeGreaterThan(0);
  expect(admitted.length).toBeLessThanOrEqual(30);
  // SDK hides some concurrent conflict causes as NotExecuted; fail closed, never retry an unknown commit.
  while (admitted.length < 30) admitted.push(await gate.store.reserve(scope, "proposal", tariff, 0));
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  await gate.store.sent(admitted[0]!.id);
  await gate.store.finish(admitted[0]!.id, { usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: null, reasoningTokens: null }, actualModel: tariff.model, requestId: "synthetic-new", cost: 0, failed: false });
  await gate.store.sent(admitted[1]!.id);
  await gate.store.finish(admitted[1]!.id, { usage: null, actualModel: null, requestId: null, cost: null, failed: true });
  const ledger = [...await gate.store.page(activityId), ...await gate.store.page(activityId, 50)];
  expect(ledger.slice(0, 30)).toEqual(old);
  expect(ledger.length).toBe(60);
  expect(ledger.filter(a => a.measurement_cycle).length).toBe(30);
  expect(ledger.find(a => String(a.id) === String(admitted[0]!.id))).toMatchObject({ state: "settled", cost: 0, usage_source: "provider" });
  expect(ledger.find(a => String(a.id) === String(admitted[1]!.id))).toMatchObject({ state: "uncertain", usage_source: "unknown" });
  expect(await gate.store.target()).toEqual(target);
  expect((await gate.store.activity(activityId))?.attempts).toBe(30);
  const cycle = await gate.store.measurementCycle();
  const disabledAgain = await registration.disable({ activity: activityId, operator: "synthetic-operator", reason: "再次禁用" });
  await registration.enable({ activity: activityId, revision: disabledAgain.revision, measurementCycle: true, operator: "synthetic-operator", reason: "幂等重启不补次数", runtime });
  expect(await gate.store.measurementCycle()).toEqual(cycle);
  await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
  // 同一目标换 activity 也不能重建一次性预算，失败事务不能启用新活动。
  const nextTag = "measurementsecond", nextActivity = `activity-${nextTag}`;
  const nextRegistered = await registration.register({ claims: claimsOf(proof(nextTag, {
    type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId: nextActivity, document,
    model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
    approval: { taskId: "synthetic-new-approval", version: 4, action: "accept", auditId: "audit:measurementsecond", reviewer: "synthetic-reviewer", digest: digest(`configuration:${nextTag}:jti-${nextTag}`) },
  })), operator: "synthetic-operator", reason: "换活动受审登记" });
  const nextEvidence = await registration.submitEvidence({ activity: nextActivity, revision: nextRegistered.revision, document, operator: "synthetic-operator", reason: "换活动证据" });
  await expect(registration.enable({ activity: nextActivity, revision: nextEvidence.revision, measurementCycle: true, operator: "synthetic-operator", reason: "换活动不可重置预算", runtime })).rejects.toThrow("登记事务未确认");
  expect((await gate.store.activity(nextActivity))?.enabled).toBe(false);
  expect(await gate.store.measurementCycle()).toEqual(cycle);
  // 进程对象重建也不能重置次数。
  expect((await new InternalAiStore(async () => db!).measurementCycle())?.attempts).toBe(30);
  expect(rows(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_target", GOAL) }))[0]?.attempts).toBe(30);
  await db.use({ namespace: "registration_test", database: "_system" });
}, 30000);

localTest("same-activity renewal with a fresh independent approval appends a disabled revision and enables only on the new document", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "renewal", activityId = `activity-${tag}`, endpoint = `https://${tariff.host}/v1`;
  const runtime = { provider: tariff.provider, model: tariff.model, endpoint };
  const service = { model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision };
  const approvalV1 = { taskId: "synthetic-renewal-approval-1", version: 1, action: "accept", auditId: "audit:renewal-1", reviewer: "synthetic-reviewer", digest: "" };
  const approvalV2 = { taskId: "synthetic-renewal-approval-2", version: 1, action: "accept", auditId: "audit:renewal-2", reviewer: "synthetic-reviewer", digest: "" };
  // 隔离库：旧 30 条账本与 target 单例都不污染主库。
  await db.query("DEFINE DATABASE IF NOT EXISTS renewal_test;");
  await db.use({ namespace: "registration_test", database: "renewal_test" });
  try {
    for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
      await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
    }
    const docV1 = tokenPlanDocument({ sampledAt: new Date(NOW - 3600000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    // 旧受审链首登即用公司规则派生摘要（续期复算的核定基准）；续期 proof 同规则派生。
    const registered = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV1,
      ...service, approval: approvalV1, deriveDigest: true,
    })), operator: "synthetic-operator", reason: "旧受审登记" });
    const submitted = await registration.submitEvidence({ activity: activityId, revision: registered.revision, document: docV1, operator: "synthetic-operator", reason: "旧证据" });
    const enabled = await registration.enable({ activity: activityId, revision: submitted.revision, operator: "synthetic-operator", reason: "旧启用", runtime });
    expect(enabled.state).toBe("enabled");
    expect(await gate.store.measurementCycle()).toBeUndefined();
    // 旧 30 已用尽：30 次零费率真实预留+结算（零费率证书预留 0，账本仍计数）。
    const scope = await gate.bind(`owner-${tag}`, `ws_${tag}`, "run-renewal-old", "key-renewal-old");
    if (!scope) throw new Error("missing bound fixture");
    for (let i = 0; i < 30; i++) {
      const ticket = await gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint));
      await gate.inRun(scope, () => gate.finish(ticket, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, tariff.model, `synthetic-old-${i}`, false));
    }
    expect((await gate.store.activity(activityId))?.attempts).toBe(30);
    expect((await gate.store.target()).attempts).toBe(30);
    await expect(gate.store.reserve(scope, "proposal", tariff, 0)).rejects.toThrow();
    const oldAttempts = await gate.store.page(activityId);
    expect(oldAttempts.length).toBe(30);
    // 旧证据过期后冻结原路径：拨过期 + 显式禁用。
    await db.query('UPDATE ONLY $id SET evidence_expires_at = "2000-01-01T00:00:00Z"', { id: new RecordId("internal_ai_activity", activityId) });
    const frozen = await registration.disable({ activity: activityId, operator: "synthetic-operator", reason: "旧证据过期冻结" });
    const beforeRenewal = await registration.revisions(activityId);
    const beforeIdentities = await registration.identities(activityId);
    // 续期：同稳定配置 + 新文档（采样更新）+ 全新独立批准 + 新 jti，摘要按公司规则派生。
    const docV2 = tokenPlanDocument({ sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(), quotaRemaining: 59999 });
    const renewed = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV2,
      ...service, approval: approvalV2, jti: "jti-renewal-2", deriveDigest: true,
    })), operator: "synthetic-operator", reason: "同活动续期登记" });
    expect(renewed.revision).toBe(frozen.revision + 1);
    expect(renewed.state).toBe("disabled");
    expect(renewed.proofType).toBe("approved-service");
    expect(renewed.approval?.taskId).toBe("synthetic-renewal-approval-2");
    expect(renewed.documentHash).toBe(bytesHash(docV2));
    expect(renewed.configurationDigest).not.toBe(beforeRenewal.at(-1)!.configuration_digest);
    expect(renewed.idempotentReplay).toBe(false);
    // 旧 revision/绑定逐字节不变；计数/reserved/spent 保持；identity_hash 不动。
    expect(await registration.revisions(activityId).then(rs => rs.slice(0, beforeRenewal.length))).toEqual(beforeRenewal);
    expect(await registration.identities(activityId)).toEqual(beforeIdentities.map(i => ({ ...i, revision: renewed.revision })));
    const ledger = await gate.store.activity(activityId);
    expect(ledger).toMatchObject({ attempts: 30, reserved: 0, spent: 0 });
    expect((await gate.store.target()).attempts).toBe(30);
    expect(await gate.store.page(activityId)).toEqual(oldAttempts);
    // 旧文档不能提交到新 revision（失配 hash）。
    await expect(registration.submitEvidence({ activity: activityId, revision: renewed.revision, document: docV1, operator: "synthetic-operator", reason: "旧文档回放" })).rejects.toThrow(/文档摘要不一致/);
    // 新文档走完 evidence → 显式 enable 才放行；旧 revision 号不能再启用。
    const submittedV2 = await registration.submitEvidence({ activity: activityId, revision: renewed.revision, document: docV2, operator: "synthetic-operator", reason: "新证据" });
    expect(submittedV2.gaps).toEqual([]);
    await expect(registration.enable({ activity: activityId, revision: renewed.revision, operator: "synthetic-operator", reason: "旧版本启用", runtime })).rejects.toThrow(/旧证据/);
    const enabledV2 = await registration.enable({ activity: activityId, revision: submittedV2.revision, operator: "synthetic-operator", reason: "续期显式启用", runtime });
    expect(enabledV2.state).toBe("enabled");
    expect(enabledV2.dataReady).toBe(true);
    expect((await gate.store.activity(activityId))?.attempts).toBe(30);
    // 旧 proof 重放：只读返回旧 revision，不新增、不覆盖新 status、不降回旧证据。
    const replay = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV1,
      ...service, approval: approvalV1, deriveDigest: true,
    })), operator: "synthetic-operator", reason: "旧票据重放" });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe(registered.revision);
    expect((await registration.revisions(activityId)).length).toBe(submittedV2.revision + 1);
    // 旧票据重放后新链路仍可用：新 revision 的 status 能力未被覆盖。
    const latestRevision = (await registration.revisions(activityId)).at(-1)!;
    expect(latestRevision.state).toBe("enabled");
    expect((await gate.store.activity(activityId))?.balance_evidence_hash).toBe(bytesHash(docV2));
    // 重复 enable 同一已启用 revision：fresh 版本检查拒绝，不补预算。
    await expect(registration.enable({ activity: activityId, revision: submittedV2.revision, operator: "synthetic-operator", reason: "重复启用", runtime })).rejects.toThrow(/旧证据/);
    expect((await gate.store.target()).attempts).toBe(30);
  } finally {
    await db.use({ namespace: "registration_test", database: "_system" });
  }
}, 30000);

localTest("renewal rejects any stable-field change, stale approval, missing approval, revoked identity and concurrent doubles", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "renewreject", activityId = `activity-${tag}`, endpoint = `https://${tariff.host}/v1`;
  const service = { model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision };
  const approvalV1 = { taskId: "synthetic-reject-approval-1", version: 1, action: "accept", auditId: "audit:reject-1", reviewer: "synthetic-reviewer", digest: "" };
  await db.query("DEFINE DATABASE IF NOT EXISTS renewal_reject_test;");
  await db.use({ namespace: "registration_test", database: "renewal_reject_test" });
  try {
    for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
      await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
    }
    const docV1 = tokenPlanDocument({ sampledAt: new Date(NOW - 3600000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const first = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV1,
      ...service, approval: approvalV1, deriveDigest: true,
    })), operator: "synthetic-operator", reason: "旧受审登记" });
    // 先落旧证据，形成已核定采样基线（stale 采样检查的比对对象）；不启用，避免门禁干扰拒绝矩阵。
    await registration.submitEvidence({ activity: activityId, revision: first.revision, document: docV1, operator: "synthetic-operator", reason: "旧证据基线" });
    const revisionCount = () => registration.revisions(activityId).then(rs => rs.length);
    expect(await revisionCount()).toBe(2);
    const docV2 = tokenPlanDocument({ sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const attemptRenew = (over: Record<string, unknown>, jti: string, approval: unknown = { taskId: `synthetic-reject-${jti}`, version: 1, action: "accept", auditId: `audit:${jti}`, reviewer: "synthetic-reviewer", digest: "" }) =>
      registration.register({ claims: claimsOf(proof(tag, {
        type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV2,
        ...service, ...over, approval, jti, deriveDigest: true,
      })), operator: "synthetic-operator", reason: "拒绝矩阵" });
    // 改任一稳定字段：服务对象/预算/workspace/证书均拒绝，且无部分写。
    for (const [name, over] of [
      ["endpoint", { endpoint: "https://other.sensenova.cn/v1" }],
      ["model", { model: "sensenova-6.8-flash" }],
      ["accountRef", { accountRef: "synthetic-other-account" }],
      ["priceRevision", { priceRevision: "synthetic-other-revision" }],
      ["budget-total", { budget: { totalNanoUsd: 500_000_000 } }],
      ["budget-attempts", { budget: { maxAttempts: 10 } }],
      ["workspace", { manifestOver: { workspaceSlug: "other-ws" } }],
    ] as const) {
      await expect(attemptRenew(over as Record<string, unknown>, `jti-reject-${name}`)).rejects.toThrow(/同活动已登记不同配置摘要/);
      expect(await revisionCount()).toBe(2);
    }
    // 改身份/别库/计费账户：摘要或绑定检查拒绝（该段仅示意，真实改库用例见下）。
    // 用 identities 覆盖构造改库身份（与 identitiesDigest 一并改，仍被绑定检查拒绝）。
    const movedIds = identities(tag);
    await expect(registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV2,
      ...service, approval: { taskId: "synthetic-reject-moved", version: 1, action: "accept", auditId: "audit:moved", reviewer: "synthetic-reviewer", digest: "" },
      jti: "jti-reject-moved", deriveDigest: true,
      identities: { owner: { ...movedIds.owner, database: "ws_moved" }, member: { ...movedIds.member, database: "ws_moved" } },
      identitiesDigest: "0".repeat(64),
    })), operator: "synthetic-operator", reason: "改库续期" })).rejects.toThrow();
    expect(await revisionCount()).toBe(2);
    // 缺批准（development-disabled 旧 marker）不放宽。
    await expect(registration.register({ claims: claimsOf(proof(tag, {
      type: "development-disabled", scope: "register-disabled", paidCallsAllowed: 0, activityId, document: docV2,
      ...service, jti: "jti-reject-dev", deriveDigest: true,
    })), operator: "synthetic-operator", reason: "开发证明续期" })).rejects.toThrow(/同活动已登记不同配置摘要/);
    // 复用旧批准任务替新文档授权：拒绝。
    await expect(attemptRenew({}, "jti-reject-oldapproval", { ...approvalV1, digest: "" })).rejects.toThrow(/同活动已登记不同配置摘要/);
    expect(await revisionCount()).toBe(2);
    // 采样倒退的新文档（早于原已核定采样）：登记可追加 revision，但证据提交拒绝。
    const staleDoc = tokenPlanDocument({ sampledAt: new Date(NOW - 7200000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const staleReg = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: staleDoc,
      ...service, approval: { taskId: "synthetic-reject-stale", version: 1, action: "accept", auditId: "audit:stale", reviewer: "synthetic-reviewer", digest: "" },
      jti: "jti-reject-stale", deriveDigest: true,
    })), operator: "synthetic-operator", reason: "倒退采样登记" });
    await expect(registration.submitEvidence({ activity: activityId, revision: staleReg.revision, document: staleDoc, operator: "synthetic-operator", reason: "倒退采样证据" })).rejects.toThrow(/早于原已核定证据/);
    expect((await registration.revisions(activityId)).length).toBe(staleReg.revision);
    // 撤销身份后：续期事务拒绝。
    await registration.revokeIdentity({ activity: activityId, alias: "LCA04_MEMBER", operator: "synthetic-operator", reason: "合成撤销" });
    await expect(attemptRenew({}, "jti-reject-revoked")).rejects.toThrow(/登记事务/);
    // 并发双续期：仅一成功，无部分写。
    await db.query("DEFINE DATABASE IF NOT EXISTS renewal_race_test;");
    await db.use({ namespace: "registration_test", database: "renewal_race_test" });
    for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
      await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
    }
    const raceTag = "renewrace", raceActivity = `activity-${raceTag}`;
    const raceService = { model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision };
    const raceDocV1 = tokenPlanDocument({ sampledAt: new Date(NOW - 3600000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    await registration.register({ claims: claimsOf(proof(raceTag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId: raceActivity, document: raceDocV1,
      ...raceService, approval: { taskId: "synthetic-race-approval-1", version: 1, action: "accept", auditId: "audit:race-1", reviewer: "synthetic-reviewer", digest: "" },
      deriveDigest: true,
    })), operator: "synthetic-operator", reason: "竞态旧登记" });
    const raceDocV2 = tokenPlanDocument({ sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const racer = (key: string) => registration.register({ claims: claimsOf(proof(raceTag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId: raceActivity, document: raceDocV2,
      ...raceService, approval: { taskId: `synthetic-race-${key}`, version: 1, action: "accept", auditId: `audit:race-${key}`, reviewer: "synthetic-reviewer", digest: "" },
      jti: `jti-race-${key}`, deriveDigest: true,
    })), operator: "synthetic-operator", reason: "并发续期" });
    const raced = await Promise.allSettled([racer("a"), racer("b")]);
    expect(raced.filter(r => r.status === "fulfilled").length).toBe(1);
    expect(raced.filter(r => r.status === "rejected").length).toBe(1);
    expect((await registration.revisions(raceActivity)).length).toBe(2);
    await db.use({ namespace: "registration_test", database: "renewal_reject_test" });
    void first;
  } finally {
    await db.use({ namespace: "registration_test", database: "_system" });
  }
}, 30000);

localTest("renewal on an activity with an existing measurement cycle cannot top up or move the cycle", async () => {
  if (!db) throw new Error("fixture unavailable");
  const tariff = TARIFFS.find(t => t.model === "sensenova-6.8-flash-lite")!;
  const tag = "renewcycle", activityId = `activity-${tag}`, endpoint = `https://${tariff.host}/v1`;
  const runtime = { provider: tariff.provider, model: tariff.model, endpoint };
  await db.query("DEFINE DATABASE IF NOT EXISTS renewal_cycle_test;");
  await db.use({ namespace: "registration_test", database: "renewal_cycle_test" });
  try {
    for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql", "036-internal-ai-token-plan.surql", "037-internal-ai-measurement-cycle.surql", "038-internal-ai-account-plan-type.surql"]) {
      await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
    }
    // 周期活动用测量身份（MEASUREMENT_DATABASE）：与 identities(tag) 的默认 ws 库不同，
    // 使 enable(measurementCycle:true) 的复测库门禁通过；续期仍要求同一身份。
    const cycleIds = {
      owner: { alias: "LCA04_REMOVABLE", subject: `owner-measurement${tag}`, spaceId: `workspace:measurement${tag}`, database: MEASUREMENT_DATABASE, workspaceRole: "admin", billingRole: "owner", billingAccountRef: `account-measurement${tag}` },
      member: { alias: "LCA04_MEMBER", subject: `member-measurement${tag}`, spaceId: `workspace:measurement${tag}`, database: MEASUREMENT_DATABASE, workspaceRole: "participant", billingRole: "member", billingAccountRef: `account-measurement${tag}` },
    } as const;
    const docV1 = tokenPlanDocument({ sampledAt: new Date(NOW - 3600000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const registered = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV1,
      model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
      approval: { taskId: "synthetic-cycle-approval-1", version: 1, action: "accept", auditId: "audit:cycle-1", reviewer: "synthetic-reviewer", digest: "" },
      identities: { owner: cycleIds.owner, member: cycleIds.member }, deriveDigest: true,
    })), operator: "synthetic-operator", reason: "周期旧登记" });
    const submitted = await registration.submitEvidence({ activity: activityId, revision: registered.revision, document: docV1, operator: "synthetic-operator", reason: "周期旧证据" });
    const cycled = await registration.enable({ activity: activityId, revision: submitted.revision, measurementCycle: true, operator: "synthetic-operator", reason: "建一次性周期", runtime });
    expect(cycled.state).toBe("enabled");
    const cycleBefore = await gate.store.measurementCycle();
    expect(cycleBefore?.attempt_limit).toBe(30);
    // 周期内先消耗 2 次：已有非空 cycle。
    const scope = await gate.bind(cycleIds.owner.subject, MEASUREMENT_DATABASE, "run-renewcycle", "key-renewcycle");
    if (!scope) throw new Error("missing bound fixture");
    for (let i = 0; i < 2; i++) {
      const ticket = await gate.inRun(scope, () => gate.begin("proposal", tariff.provider, tariff.model, endpoint));
      await gate.inRun(scope, () => gate.finish(ticket, { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, tariff.model, `synthetic-cycle-${i}`, false));
    }
    const cycleUsed = await gate.store.measurementCycle();
    expect(cycleUsed?.attempts).toBe(2);
    // 续期登记+新证据：允许（追加 disabled revision），但 measurementCycle enable 照旧冲突。
    const docV2 = tokenPlanDocument({ sampledAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString() });
    const renewed = await registration.register({ claims: claimsOf(proof(tag, {
      type: "approved-service", scope: "enable", paidCallsAllowed: 1, activityId, document: docV2,
      model: tariff.model, endpoint, accountRef: "synthetic-sensenova-account", priceRevision: tariff.revision,
      approval: { taskId: "synthetic-cycle-approval-2", version: 1, action: "accept", auditId: "audit:cycle-2", reviewer: "synthetic-reviewer", digest: "" },
      jti: "jti-cycle-2", deriveDigest: true,
      identities: { owner: cycleIds.owner, member: cycleIds.member },
    })), operator: "synthetic-operator", reason: "周期活动续期" });
    const submittedV2 = await registration.submitEvidence({ activity: activityId, revision: renewed.revision, document: docV2, operator: "synthetic-operator", reason: "周期新证据" });
    // 普通 enable 可走（新证据门禁全过），但 measurementCycle 分支因 evidence_hash 失配照旧拒绝。
    const enabledV2 = await registration.enable({ activity: activityId, revision: submittedV2.revision, operator: "synthetic-operator", reason: "周期活动普通启用", runtime });
    expect(enabledV2.state).toBe("enabled");
    await expect(registration.enable({ activity: activityId, revision: submittedV2.revision, operator: "synthetic-operator", reason: "周期不可搬迁", runtime })).rejects.toThrow(/旧证据/);
    const disabledV2 = await registration.disable({ activity: activityId, operator: "synthetic-operator", reason: "再冻结" });
    await expect(registration.enable({ activity: activityId, revision: disabledV2.revision, measurementCycle: true, operator: "synthetic-operator", reason: "新证据不可重建周期", runtime })).rejects.toThrow("登记事务未确认");
    // 已有非空 cycle 完整快照不变：固定 id/owner/attempt_limit/attempts/approval/evidence_hash/expiry。
    expect(await gate.store.measurementCycle()).toEqual(cycleUsed);
  } finally {
    await db.use({ namespace: "registration_test", database: "_system" });
  }
}, 30000);
