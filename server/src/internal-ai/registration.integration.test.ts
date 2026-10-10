import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordId, Surreal } from "surrealdb";
import {
  COMPANY_PROOF_AUDIENCE, COMPANY_PROOF_GOAL, COMPANY_PROOF_ISSUER, COMPANY_PROOF_PROJECT, COMPANY_PROOF_TYP,
  type CompanyProofClaims,
} from "@surreal-ck/shared";
import { InternalAiRegistration } from "./registration";
import { verifyCompanyProof } from "./company-proof";
import { InternalAiGate } from "./gate";
import { InternalAiStore, hash } from "./store";
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
    owner: { alias: "LCA04_REMOVABLE", subject: `owner-${tag}`, spaceId: `workspace:${tag}`, database: `ws_${tag}`, workspaceRole: "admin", billingRole: "owner", billingAccountRef: `account-${tag}` },
    member: { alias: "LCA04_MEMBER", subject: `member-${tag}`, spaceId: `workspace:${tag}`, database: `ws_${tag}`, workspaceRole: "participant", billingRole: "member", billingAccountRef: `account-${tag}` },
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

/** 按公司 proof-bridge 的 sign('proof', …) 形状构造并自签一份证明；documentHash 由真实文档字节算。 */
function proof(tag: string, overrides: {
  jti?: string; type?: "development-disabled" | "approved-service"; scope?: "register-disabled" | "enable";
  paidCallsAllowed?: 0 | 1; model?: string; endpoint?: string; accountRef?: string; activityId?: string;
  priceRevision?: string; budget?: Record<string, unknown>; approval?: unknown;
  document?: string; evidence?: Record<string, unknown>;
} = {}): string {
  const ids = identities(tag);
  const model = overrides.model ?? "sensenova-6.8-flash-lite";
  const endpoint = overrides.endpoint ?? "https://token.sensenova.cn/v1";
  const accountRef = overrides.accountRef ?? "synthetic-existing-service";
  const priceRevision = overrides.priceRevision ?? "synthetic-unsupported";
  const document = overrides.document ?? evidenceDocument(tag, overrides.evidence);
  const documentHash = bytesHash(document);
  const configurationDigest = digest(`configuration:${tag}:jti-${tag}`);
  const manifest = {
    schemaVersion: 1, goalId: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, env: "production",
    activityId: overrides.activityId ?? `activity-${tag}`, workspaceSlug: "ui01", documentHash,
    service: { accountRef, endpoint, model, priceRevision },
    budget: { currency: "USD", totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true, ...overrides.budget },
    identities: [
      { alias: "LCA04_REMOVABLE", workspaceRole: "admin", billingRole: "owner" },
      { alias: "LCA04_MEMBER", workspaceRole: "participant", billingRole: "member" },
    ],
    configurationDigest,
  };
  const payload = {
    contractVersion: 1, type: overrides.type ?? "development-disabled",
    paidCallsAllowed: overrides.paidCallsAllowed ?? 0, scope: overrides.scope ?? "register-disabled",
    project: COMPANY_PROOF_PROJECT, env: "production", goal: COMPANY_PROOF_GOAL,
    requestTask: `company-task-${tag}`,
    lease: { goal: COMPANY_PROOF_GOAL, project: COMPANY_PROOF_PROJECT, role: "engineering", employee: "synthetic-employee", taskId: `company-task-${tag}`, delivery: `delivery-${tag}`, fence: 1 },
    approval: overrides.approval ?? null, documentHash, manifest, configurationDigest,
    identities: [ids.owner, ids.member],
    identitiesDigest: digest(`identities:${tag}`),
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
  for (const file of ["034-internal-ai-budget.surql", "035-internal-ai-registration.surql"]) {
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
    model: tariff.model, priceRevision: tariff.revision, currency: "USD", balanceNanoUsd: 1_000_000_000,
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

localTest("missing or withdrawn company status denies registration and every model attempt", async () => {
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
  const checkedGate = new InternalAiGate(new InternalAiStore(async () => db!), async () => assert());
  const scope = await checkedGate.bind(`owner-${tag}`, `ws_${tag}`, "run-status", "key-status");
  await expect(checkedGate.inRun(scope, () => checkedGate.begin("proposal", "openai", "sensenova-6.8-flash-lite", "https://token.sensenova.cn/v1"))).rejects.toThrow(/revoked/);
});


localTest("normal identity projection cannot swap roles or billing accounts", async () => {
  const valid = claimsOf(proof("roles"));
  const [owner, member] = valid.identities;
  for (const identities of [[member, owner], [owner, { ...member, billingAccountRef: "different-account" }], [owner, { ...member, subject: owner.subject }]] as const) {
    await expect(registration.register({ claims: { ...valid, identities: [identities[0], identities[1]] }, operator: "synthetic-operator", reason: "身份配对冲突" })).rejects.toThrow(/身份角色/);
  }
  expect((await registration.revisions(valid.manifest.activityId)).length).toBe(0);
});
