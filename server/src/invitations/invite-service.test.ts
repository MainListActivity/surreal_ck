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
    });
    return { kind: "claimed" as const };
  }

  async complete(recordId: string, outcome: InviteOutcome) {
    const row = [...this.rows.values()].find((r) => r.id === recordId);
    if (row) this.rows.set(row.idempotencyKey, { ...row, status: "completed", outcome, completedAt: new Date().toISOString() });
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
}

type Call = { name: string; detail?: unknown };

function makeService(overrides: {
  idpResult?: EnsureUserResult | Error | null;
  createResult?: CreateWorkspaceResult;
  assignError?: Error;
  grantError?: Error;
  existingBuckets?: { period_key: string; id: string }[];
  defaultRevision?: string | null;
  store?: MemStore;
} = {}) {
  const calls: Call[] = [];
  const store = overrides.store ?? new MemStore();
  const idp = overrides.idpResult === null
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
      } as unknown as HttpIdpAdminClient;
  const service = new InviteService({
    idp,
    workspaceCreator: {
      createWorkspace: async () => {
        calls.push({ name: "createWorkspace" });
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

  test("processing 中的同键请求 → invite-in-progress", async () => {
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
      status: "processing", outcome: null, errorCode: null, errorMessage: null, createdAt: null, completedAt: null,
    });
    const { service } = makeService({ store });
    await expect(service.provision(ACTOR, input())).rejects.toMatchObject({ code: "invite-in-progress" });
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
});
