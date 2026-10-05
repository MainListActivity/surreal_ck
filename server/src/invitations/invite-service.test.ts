import { describe, expect, test } from "bun:test";
import type { CreateOpsInvitation } from "@surreal-ck/shared";
import type { CreateWorkspaceResult } from "../workspaces/create-workspace";
import type { EnsureUserResult } from "./idp-admin-client";
import { HttpIdpAdminClient } from "./idp-admin-client";
import type { InviteAuditRow, InviteAuditStore, InviteClaimInsert, InviteOutcome, WorkspaceIndexRow } from "./invite-store";
import { InviteService, type InviteActor } from "./invite-service";

const ACTOR: InviteActor = { subject: "ops-subject", capabilities: ["subscription.manage", "quota.read"] };

function input(overrides: Partial<CreateOpsInvitation> = {}): CreateOpsInvitation {
  return {
    email: "lawyer@example.com",
    displayName: "陈律师",
    workspaceSlug: "acme-bankruptcy",
    planKey: "pro",
    aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z", label: "邀请试点 AI 额度" },
    reason: "G2 试点邀请",
    idempotencyKey: "invite-test-key-001",
    ...overrides,
  };
}

class MemStore implements InviteAuditStore {
  rows = new Map<string, InviteAuditRow>();
  workspaces = new Map<string, WorkspaceIndexRow>();
  /** 行级暂存的一次性激活链接（不入 InviteAuditRow 读路径）。 */
  storedUrls = new Map<string, string>();
  deliveredAt = new Map<string, string>();
  markProcessingCalls = 0;
  markProcessingResult: boolean | null = null;

  async claim(insert: InviteClaimInsert) {
    const existing = this.rows.get(insert.idempotencyKey);
    if (existing) return { kind: "existing" as const, row: existing };
    this.rows.set(insert.idempotencyKey, {
      id: insert.recordId,
      idempotencyKey: insert.idempotencyKey,
      operatorSubject: insert.operatorSubject,
      email: insert.email,
      displayName: insert.displayName,
      workspaceSlug: insert.workspaceSlug,
      workspaceName: insert.workspaceName,
      planKey: insert.planKey,
      reason: insert.reason,
      requestDigest: insert.requestDigest,
      status: "processing",
      outcome: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      processingSince: new Date().toISOString(),
      activationUrlPending: false,
      resentAt: null,
      resentBy: null,
    });
    return { kind: "claimed" as const };
  }

  async complete(recordId: string, outcome: InviteOutcome) {
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (row) {
      this.rows.set(row.idempotencyKey, {
        ...row, status: "completed", outcome, completedAt: new Date().toISOString(),
        activationUrlPending: this.storedUrls.has(recordId),
      });
    }
  }

  async fail(recordId: string, code: string, message: string) {
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (row) this.rows.set(row.idempotencyKey, { ...row, status: "failed", errorCode: code, errorMessage: message });
  }

  async byKey(key: string) {
    return this.rows.get(key) ?? null;
  }

  async workspaceBySlug(slug: string) {
    return this.workspaces.get(slug) ?? null;
  }

  async markProcessing(recordId: string, staleBefore: Date) {
    this.markProcessingCalls += 1;
    if (this.markProcessingResult !== null) return this.markProcessingResult;
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (!row || row.status !== "processing") return false;
    const startedAt = row.processingSince ?? row.createdAt;
    if (startedAt && Date.parse(startedAt) >= staleBefore.getTime()) return false;
    this.rows.set(row.idempotencyKey, { ...row, processingSince: new Date().toISOString() });
    return true;
  }

  async saveActivationUrl(recordId: string, activationUrl: string) {
    this.storedUrls.set(recordId, activationUrl);
  }

  async storedActivationUrl(recordId: string) {
    return this.storedUrls.get(recordId) ?? null;
  }

  async collectActivationUrl(recordId: string) {
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (!row || row.status !== "completed") return { activationUrl: null, deliveredAt: null };
    const url = this.storedUrls.get(recordId) ?? null;
    const delivered = this.deliveredAt.get(recordId) ?? null;
    if (!url || delivered) return { activationUrl: null, deliveredAt: delivered };
    const now = new Date().toISOString();
    this.deliveredAt.set(recordId, now);
    this.storedUrls.delete(recordId);
    this.rows.set(row.idempotencyKey, { ...row, activationUrlPending: false });
    return { activationUrl: url, deliveredAt: now };
  }

  async saveResentActivationUrl(recordId: string, activationUrl: string, actorSubject: string) {
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (!row || row.status !== "completed") return false;
    this.storedUrls.set(recordId, activationUrl);
    this.deliveredAt.delete(recordId);
    this.rows.set(row.idempotencyKey, {
      ...row,
      activationUrlPending: true,
      resentAt: new Date().toISOString(),
      resentBy: actorSubject,
    });
    return true;
  }
}

type Call = { name: string; detail?: unknown };

function makeService(overrides: {
  idpResult?: EnsureUserResult | Error | null;
  reissueResult?: { user: { id: string; email: string; displayName: string; status: string }; activationUrl: string | null } | Error;
  createResult?: CreateWorkspaceResult;
  assignError?: Error;
  grantError?: Error;
  existingBuckets?: { period_key: string; id: string }[];
  defaultRevision?: string | null;
  store?: MemStore;
  syncWindowMs?: number;
  staleProcessingMs?: number;
  createDelayMs?: number;
} = {}) {
  const calls: Call[] = [];
  const store = overrides.store ?? new MemStore();
  const idp = async () => overrides.idpResult === null
    ? null
    : {
        ensureUser: async () => {
          calls.push({ name: "idp.ensureUser" });
          const r = overrides.idpResult ?? {
            user: { id: "user-1", email: "lawyer@example.com", displayName: "陈律师", status: "provisioned" },
            created: true,
            activationUrl: "https://o.maplayer.top/activate-account?token=SECRET",
          };
          if (r instanceof Error) throw r;
          return r;
        },
        reissueActivation: async (userId: string) => {
          calls.push({ name: "idp.reissueActivation", detail: { userId } });
          const r = overrides.reissueResult ?? {
            user: { id: "user-1", email: "lawyer@example.com", displayName: "陈律师", status: "provisioned" },
            activationUrl: "https://o.maplayer.top/activate-account?token=RESENT-SECRET",
          };
          if (r instanceof Error) throw r;
          return r;
        },
      } as unknown as HttpIdpAdminClient;
  const service = new InviteService({
    idp,
    syncWindowMs: overrides.syncWindowMs,
    staleProcessingMs: overrides.staleProcessingMs,
    workspaceCreator: {
      createWorkspace: async () => {
        calls.push({ name: "createWorkspace" });
        if (overrides.createDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, overrides.createDelayMs));
        }
        return overrides.createResult ?? { kind: "created", slug: "acme-bankruptcy", dbName: "ws_abc123", accessToken: null, expiresIn: null };
      },
    },
    products: {
      assign: async (_actor: unknown, input: { productPlanRevisionId: string }) => {
        calls.push({ name: "assign", detail: input });
        if (overrides.assignError) throw overrides.assignError;
        return {} as never;
      },
    },
    allowance: {
      balance: async () => {
        calls.push({ name: "balance" });
        return {
          pending: 0, unavailable: 0, available: 0, reserved: 0, suspended: 0, terminated: 0, expired: 0,
          buckets: (overrides.existingBuckets ?? []) as never[],
        };
      },
      grant: async (grant: { periodKey: string }) => {
        calls.push({ name: "grant", detail: grant });
        if (overrides.grantError) throw overrides.grantError;
        return { bucket: "ai_allowance_bucket:xyz" };
      },
    },
    store,
    defaultProductRevision: async () => overrides.defaultRevision === undefined ? "product_plan_revision:trial_v1" : overrides.defaultRevision,
  });
  return { service, calls, store };
}

describe("G2 InviteService", () => {
  test("全链路：建用户→建 workspace→绑定权益→授额→审计完成，activation_url 仅本次返回", async () => {
    const { service, calls, store } = makeService();
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("completed");
    expect(result.replayed).toBe(false);
    expect(result.user).toEqual({ id: "user-1", email: "lawyer@example.com", status: "provisioned", outcome: "created" });
    expect(result.workspace).toEqual({ slug: "acme-bankruptcy", dbName: "ws_abc123", outcome: "created" });
    expect(result.entitlement?.productPlanRevisionId).toBe("product_plan_revision:trial_v1");
    expect(result.entitlement?.billingAccountKey).toBe("personal:user-1");
    expect(result.aiAllowance?.periodKey).toBe("invite:invite-test-key-001");
    expect(result.delivery.activationUrl).toContain("activate-account?token=");
    expect(calls.map((c) => c.name)).toEqual(["idp.ensureUser", "createWorkspace", "assign", "balance", "grant"]);
    const audit = await store.byKey("invite-test-key-001");
    expect(audit?.status).toBe("completed");
    expect(audit?.outcome?.activationUrlIssued).toBe(true);
    // 审计行不存 token/url 本体。
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });

  test("幂等重放：同键同参返回既有结果，不重复建 ws/授额，activation_url 不再下发", async () => {
    const { service, calls } = makeService();
    await service.provision(ACTOR, input());
    calls.length = 0;
    const replay = await service.provision(ACTOR, input());
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("completed");
    expect(replay.delivery.activationUrl).toBeNull();
    expect(calls).toEqual([]);
  });

  test("幂等键复用不同参数 → invite-conflict", async () => {
    const { service } = makeService();
    await service.provision(ACTOR, input());
    await expect(service.provision(ACTOR, input({ workspaceSlug: "other-slug" })))
      .rejects.toMatchObject({ code: "invite-conflict" });
  });

  test("既有用户复用（IdP 409→lookup）：不签发新 activation_url", async () => {
    const { service } = makeService({
      idpResult: {
        user: { id: "user-9", email: "lawyer@example.com", displayName: "陈律师", status: "active" },
        created: false,
        activationUrl: null,
      },
    });
    const result = await service.provision(ACTOR, input());
    expect(result.user?.outcome).toBe("reused");
    expect(result.delivery.channel).toBe("none");
    expect(result.delivery.activationUrl).toBeNull();
  });

  test("slug 被他人占用 → invite-slug-taken 409 语义，审计记 failed", async () => {
    const store = new MemStore();
    store.workspaces.set("acme-bankruptcy", { ownerSubject: "someone-else", dbName: "ws_other", status: "active" });
    const { service } = makeService({ store, createResult: { kind: "slug-conflict" } });
    await expect(service.provision(ACTOR, input())).rejects.toMatchObject({ code: "invite-slug-taken" });
    const audit = await store.byKey("invite-test-key-001");
    expect(audit?.status).toBe("failed");
    expect(audit?.errorCode).toBe("invite-slug-taken");
  });

  test("slug 归同一被邀请人 → workspace 复用继续走完权益与授额", async () => {
    const store = new MemStore();
    store.workspaces.set("acme-bankruptcy", { ownerSubject: "user-1", dbName: "ws_abc123", status: "active" });
    const { service } = makeService({ store, createResult: { kind: "slug-conflict" } });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("completed");
    expect(result.workspace?.outcome).toBe("reused");
    expect(result.workspace?.dbName).toBe("ws_abc123");
  });

  test("IdP 凭证缺失 → invite-idp-not-configured（fail closed，不动任何下游）", async () => {
    const { service, calls } = makeService({ idpResult: null });
    await expect(service.provision(ACTOR, input())).rejects.toMatchObject({ code: "invite-idp-not-configured" });
    expect(calls).toEqual([]);
  });

  test("额度有效期为过去 → invite-allowance-expiry-invalid", async () => {
    const { service } = makeService();
    await expect(
      service.provision(ACTOR, input({ aiAllowance: { amount: 500, expiresAt: "2020-01-01T00:00:00Z", label: "x" } })),
    ).rejects.toMatchObject({ code: "invite-allowance-expiry-invalid" });
  });

  test("processing 中的同键请求 → 返回 processing 供轮询（不再抛 invite-in-progress）", async () => {
    const store = new MemStore();
    const { stableSha256 } = await import("../quota/canonical");
    const digest = stableSha256(JSON.stringify({
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: null, planKey: "pro", productPlanRevisionId: null,
      aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z", label: "邀请试点 AI 额度" }, reason: "G2 试点邀请",
    }));
    store.rows.set("invite-test-key-001", {
      id: "ops_invitation:x", idempotencyKey: "invite-test-key-001", operatorSubject: "ops-subject",
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: "陈律师", planKey: "pro", reason: "G2 试点邀请", requestDigest: digest,
      status: "processing", outcome: null, errorCode: null, errorMessage: null,
      createdAt: null, completedAt: null,
      processingSince: new Date().toISOString(), activationUrlPending: false,
      resentAt: null, resentBy: null,
    });
    const { service, calls } = makeService({ store });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("processing");
    expect(result.replayed).toBe(true);
    expect(calls).toEqual([]);
    expect(store.markProcessingCalls).toBe(0);
  });

  test("同步窗内未完成的 POST → processing；后台任务跑完后 GET completed + collect 一次性收取", async () => {
    const store = new MemStore();
    const { service } = makeService({ store, syncWindowMs: 20, createDelayMs: 120 });
    const first = await service.provision(ACTOR, input());
    expect(first.status).toBe("processing");
    expect(first.replayed).toBe(false);
    expect(first.delivery.activationUrl).toBeNull();
    // 后台任务仍在跑：GET 仍 processing（URL 已先落行待收取）
    await new Promise((r) => setTimeout(r, 30));
    const mid = await service.get("invite-test-key-001");
    expect(mid?.status).toBe("processing");
    // 收取不合法——未完成不返回 URL
    const earlyCollect = await service.collect("invite-test-key-001");
    expect(earlyCollect?.status).toBe("processing");
    expect(earlyCollect?.activationUrl).toBeNull();
    // 等后台任务跑完
    await new Promise((r) => setTimeout(r, 150));
    const done = await service.get("invite-test-key-001");
    expect(done?.status).toBe("completed");
    expect(done?.delivery.pendingCollect).toBe(true);
    // 首次 collect → URL；二次 collect → 不再返回
    const collect1 = await service.collect("invite-test-key-001");
    expect(collect1?.activationUrl).toContain("activate-account?token=");
    const collect2 = await service.collect("invite-test-key-001");
    expect(collect2?.activationUrl).toBeNull();
    expect(collect2?.deliveredAt).not.toBeNull();
    // 审计行仍不含 URL 本体
    const audit = await store.byKey("invite-test-key-001");
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });

  test("同步窗内完成 → 响应携带 URL 且记为已收取，collect 不再返回", async () => {
    const { service } = makeService({ syncWindowMs: 5_000 });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("completed");
    expect(result.delivery.activationUrl).toContain("activate-account?token=");
    const collect = await service.collect("invite-test-key-001");
    expect(collect?.activationUrl).toBeNull();
    expect(collect?.deliveredAt).not.toBeNull();
  });

  test("僵死 processing（上轮断连）→ 同参重发续跑并完成；读回首签 URL 一并下发", async () => {
    const store = new MemStore();
    const { stableSha256 } = await import("../quota/canonical");
    const digest = stableSha256(JSON.stringify({
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: null, planKey: "pro", productPlanRevisionId: null,
      aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z", label: "邀请试点 AI 额度" }, reason: "G2 试点邀请",
    }));
    const recordId = "ops_invitation:x";
    store.rows.set("invite-test-key-001", {
      id: recordId, idempotencyKey: "invite-test-key-001", operatorSubject: "ops-subject",
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: "陈律师", planKey: "pro", reason: "G2 试点邀请", requestDigest: digest,
      status: "processing", outcome: null, errorCode: null, errorMessage: null,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), completedAt: null,
      processingSince: new Date(Date.now() - 10 * 60_000).toISOString(), activationUrlPending: false,
      resentAt: null, resentBy: null,
    });
    // 上轮已签发但随请求丢失的 URL 仍在行上
    store.storedUrls.set(recordId, "https://o.maplayer.top/activate-account?token=REVIVED");
    store.workspaces.set("acme-bankruptcy", { ownerSubject: "user-9", dbName: "ws_abc123", status: "active" });
    const { service, calls } = makeService({
      store,
      staleProcessingMs: 60_000,
      idpResult: {
        user: { id: "user-9", email: "lawyer@example.com", displayName: "陈律师", status: "provisioned" },
        created: false,
        activationUrl: null,
      },
      createResult: { kind: "slug-conflict" },
      existingBuckets: [{ period_key: "invite:invite-test-key-001", id: "ai_allowance_bucket:old" }],
    });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("completed");
    expect(result.replayed).toBe(true);
    // 续跑全链路幂等：workspace 复用、授额查重不重复
    expect(result.workspace?.outcome).toBe("reused");
    expect(result.aiAllowance?.bucket).toBe("ai_allowance_bucket:old");
    expect(calls.filter((c) => c.name === "grant")).toEqual([]);
    // 上环签发的链接读回并随响应下发
    expect(result.delivery.activationUrl).toBe("https://o.maplayer.top/activate-account?token=REVIVED");
    expect(store.markProcessingCalls).toBe(1);
  });

  test("僵死行 CAS 续跑竞争失败 → 只回 processing（幂等竞态防护）", async () => {
    const store = new MemStore();
    const { stableSha256 } = await import("../quota/canonical");
    const digest = stableSha256(JSON.stringify({
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: null, planKey: "pro", productPlanRevisionId: null,
      aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z", label: "邀请试点 AI 额度" }, reason: "G2 试点邀请",
    }));
    store.rows.set("invite-test-key-001", {
      id: "ops_invitation:x", idempotencyKey: "invite-test-key-001", operatorSubject: "ops-subject",
      email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
      workspaceName: "陈律师", planKey: "pro", reason: "G2 试点邀请", requestDigest: digest,
      status: "processing", outcome: null, errorCode: null, errorMessage: null,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), completedAt: null,
      processingSince: new Date(Date.now() - 10 * 60_000).toISOString(), activationUrlPending: false,
      resentAt: null, resentBy: null,
    });
    store.markProcessingResult = false; // 另一实例已抢先续跑
    const { service, calls } = makeService({ store, staleProcessingMs: 60_000 });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("processing");
    expect(result.replayed).toBe(true);
    expect(calls).toEqual([]); // 未触发任何下游写
  });

  test("授额中途失败后同键换不来重试；period_key 查重防双桶", async () => {
    // 场景：上次在 grant 后、audit.complete 前崩溃 → 行卡 processing → 新键重试
    // 时 workspace slug-conflict→reused + balance 命中既有 period_key → 不再授额。
    const store = new MemStore();
    store.workspaces.set("acme-bankruptcy", { ownerSubject: "user-1", dbName: "ws_abc123", status: "active" });
    const { service, calls } = makeService({
      store,
      createResult: { kind: "slug-conflict" },
      existingBuckets: [{ period_key: "invite:invite-test-key-001", id: "ai_allowance_bucket:old" }],
    });
    const result = await service.provision(ACTOR, input());
    expect(result.status).toBe("completed");
    expect(result.aiAllowance?.bucket).toBe("ai_allowance_bucket:old");
    expect(calls.filter((c) => c.name === "grant")).toEqual([]);
  });

  test("显式 productPlanRevisionId 优先于默认配置", async () => {
    const { service, calls } = makeService();
    await service.provision(ACTOR, input({ productPlanRevisionId: "product_plan_revision:explicit_v2" }));
    const assign = calls.find((c) => c.name === "assign");
    expect((assign?.detail as { productPlanRevisionId: string }).productPlanRevisionId).toBe("product_plan_revision:explicit_v2");
  });

  test("无产品版本可用 → invite-product-revision-missing", async () => {
    const { service } = makeService({ defaultRevision: null });
    await expect(service.provision(ACTOR, input())).rejects.toMatchObject({ code: "invite-product-revision-missing" });
  });

  const completedRow = (overrides: Partial<InviteAuditRow> = {}): InviteAuditRow => ({
    id: "ops_invitation:x", idempotencyKey: "invite-test-key-001", operatorSubject: "ops-subject",
    email: "lawyer@example.com", displayName: "陈律师", workspaceSlug: "acme-bankruptcy",
    workspaceName: "陈律师", planKey: "pro", reason: "G2 试点邀请", requestDigest: "d",
    status: "completed", errorCode: null, errorMessage: null,
    outcome: {
      idpUserId: "user-1", idpUserStatus: "provisioned", userOutcome: "created",
      workspaceDb: "ws_abc123", workspaceOutcome: "created",
      productRevision: "product_plan_revision:trial_v1", contentAssigned: true,
      aiAllowance: { kind: "compensation", amount: 500, periodKey: "invite:invite-test-key-001", expiresAt: "2099-01-01T00:00:00Z", bucket: "ai_allowance_bucket:xyz" },
      deliveryChannel: "activation_url", activationUrlIssued: true,
    },
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    processingSince: null, activationUrlPending: false, resentAt: null, resentBy: null,
    ...overrides,
  });

  test("resend：completed 行 → IdP 重签发 → 暂存回行 → collect 一次性收取新链接", async () => {
    const store = new MemStore();
    store.rows.set("invite-test-key-001", completedRow());
    const { service, calls } = makeService({ store });

    const res = await service.resend(ACTOR, "invite-test-key-001");
    expect(res?.status).toBe("completed");
    expect(res?.delivery.pendingCollect).toBe(true);
    expect(res?.delivery.activationUrl).toBeNull();
    expect(calls.map((c) => c.name)).toEqual(["idp.reissueActivation"]);
    expect(calls[0]?.detail).toEqual({ userId: "user-1" });

    const audit = await store.byKey("invite-test-key-001");
    expect(audit?.resentBy).toBe("ops-subject");
    expect(audit?.resentAt).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("RESENT-SECRET");

    const collected = await service.collect("invite-test-key-001");
    expect(collected?.activationUrl).toContain("token=RESENT-SECRET");
    expect((await service.collect("invite-test-key-001"))?.activationUrl).toBeNull();
  });

  test("resend 重放去重：未收取链接或 24h 有效期内不再铸新链", async () => {
    const store = new MemStore();
    store.rows.set("invite-test-key-001", completedRow({ activationUrlPending: true }));
    store.storedUrls.set("ops_invitation:x", "https://o.maplayer.top/activate-account?token=OLD");
    const { service, calls } = makeService({ store });
    const res = await service.resend(ACTOR, "invite-test-key-001");
    expect(res?.delivery.pendingCollect).toBe(true);
    expect(calls).toEqual([]); // 未触达 IdP
    // 待收链接仍是原来那条，未被新 token 打死
    expect((await service.collect("invite-test-key-001"))?.activationUrl).toContain("token=OLD");

    // 已收取但上次重签发仍在 24h 有效期内 → 同样不铸新链
    store.rows.set("invite-test-key-001", completedRow({ resentAt: new Date().toISOString(), resentBy: "ops-subject" }));
    const res2 = await service.resend(ACTOR, "invite-test-key-001");
    expect(res2?.delivery.pendingCollect).toBe(false);
    expect(calls).toEqual([]);
  });

  test("resend 状态门：processing/failed → 409 语义；不存在 → null；IdP 409/404 → 邀请错误码", async () => {
    const store = new MemStore();
    store.rows.set("invite-test-key-001", completedRow({ status: "processing", outcome: null }));
    const { service } = makeService({ store });
    await expect(service.resend(ACTOR, "invite-test-key-001")).rejects.toMatchObject({ code: "invite-resend-while-processing" });

    store.rows.set("invite-test-key-001", completedRow({ status: "failed", outcome: null }));
    await expect(service.resend(ACTOR, "invite-test-key-001")).rejects.toMatchObject({ code: "invite-resend-invalid-state" });

    expect(await service.resend(ACTOR, "missing-key")).toBeNull();

    store.rows.set("invite-test-key-001", completedRow());
    const { IdpAdminError } = await import("./idp-admin-client");
    const conflicted = makeService({ store, reissueResult: new IdpAdminError("idp-admin-user-not-provisioned", "m", 409) });
    await expect(conflicted.service.resend(ACTOR, "invite-test-key-001")).rejects.toMatchObject({ code: "invite-already-activated" });
    const missing = makeService({ store, reissueResult: new IdpAdminError("idp-admin-user-not-found", "m", 404) });
    await expect(missing.service.resend(ACTOR, "invite-test-key-001")).rejects.toMatchObject({ code: "invite-idp-user-missing" });
    const noUrl = makeService({ store, reissueResult: { user: { id: "user-1", email: "e", displayName: "d", status: "provisioned" }, activationUrl: null } });
    await expect(noUrl.service.resend(ACTOR, "invite-test-key-001")).rejects.toMatchObject({ code: "invite-resend-no-url" });
  });
});
