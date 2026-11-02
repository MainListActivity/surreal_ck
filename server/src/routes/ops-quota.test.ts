import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { StringRecordId } from "surrealdb";
import type {
  PlatformOperatorCapability,
  QuotaApiOperatorView,
  QuotaOpsIntentPreflightSummaryView,
  QuotaOpsIntentPreflightView,
  QuotaOpsPlanRevision,
} from "@surreal-ck/shared/native-quota";
import { createApp } from "../app";
import { env, overrideEnv } from "../env";
import type { AppBindings } from "../hono-types";
import {
  requirePlatformOperator,
  type PlatformOperatorCapabilityReader,
} from "../ops/operator-auth";
import type { QuotaIntentStatusReader } from "../quota/quota-intent-status";
import type { QuotaOpsConsolePort } from "../quota/quota-ops-console";
import {
  QuotaOpsPreflightService,
  type QuotaOpsFreshReadPort,
  type QuotaOpsPreflightPort,
} from "../quota/quota-ops-preflight";
import type { OperatorIntentSubmission } from "../quota/subscription-lifecycle";
import type {
  QuotaOperatorIntentPort,
} from "./ops-quota";
import type { QuotaReadPort } from "./quota";

const testUser = {
  subject: "operator-123",
  email: "operator@example.test",
  raw: {},
  rawToken: "test-token",
};

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", testUser);
  await next();
};

const noReads: QuotaReadPort = {
  async getWorkspace() {
    return { kind: "not_found" };
  },
  async getBillingAccount() {
    return { kind: "not_found" };
  },
};

const noStatus: QuotaIntentStatusReader = {
  async get() {
    return null;
  },
};

const acceptedPreflight: QuotaOpsPreflightPort = {
  async preflight(input) {
    return {
      format_version: 1,
      workspace: {
        id: input.workspace.toString(),
        slug: input.workspaceSlug,
        name: "Demo",
      },
      kind: input.kind,
      required_capability: "override.manage",
      observed_at: "2026-07-28T00:59:59.000Z",
      usage_trusted: true,
      stale: false,
      effective_at: input.effectiveAt,
      current_plan: null,
      target_plan: null,
      resources: [],
      overage_count: 0,
      affected_capabilities: ["quota adjustment"],
      before_digest: "native-digest",
    };
  },
};

describe("quota operations routes", () => {
  test("persists an audited intent and returns 202 status location", async () => {
    const submissions: OperatorIntentSubmission[] = [];
    const intents: QuotaOperatorIntentPort = {
      async submitOperatorIntent(input) {
        submissions.push(input);
        return {
          kind: "accepted",
          intent: new StringRecordId("quota_operator_intent:req-1"),
        };
      },
    };
    const app = createApp({
      quotaReadService: noReads,
      quotaOperatorIntents: intents,
      quotaIntentStatus: noStatus,
      quotaOpsPreflight: acceptedPreflight,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request("http://localhost/api/ops/quota/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "override_schedule",
          requestId: "req-1",
          workspaceSlug: "demo",
          workspace: "workspace:demo",
          customerReason: "临时扩容",
          operatorReason: "支持工单 #42",
          effectiveAt: "2026-07-28T01:00:00.000Z",
          input: { mode: "temporary" },
        }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      id: "quota_operator_intent:req-1",
      status: "accepted",
      statusUrl:
        "/api/ops/quota/intents/quota_operator_intent%3Areq-1",
    });
    expect(submissions[0]).toMatchObject({
      kind: "override_schedule",
      actorSubject: "operator-123",
      actorCapability: "override.manage",
      requestId: "req-1",
      customerReason: "临时扩容",
      operatorReason: "支持工单 #42",
      input: { mode: "temporary" },
      impactPreview: {
        format_version: 1,
        observed_at: "2026-07-28T00:59:59.000Z",
        usage_trusted: true,
      },
      beforeDigest: "native-digest",
    });
    expect(submissions[0]?.workspace?.toString()).toBe("workspace:demo");
  });

  test("status reader decides authorization; object id alone returns 404", async () => {
    const app = createApp({
      quotaReadService: noReads,
      quotaOperatorIntents: {
        async submitOperatorIntent() {
          throw new Error("not used");
        },
      },
      quotaIntentStatus: noStatus,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request(
        "http://localhost/api/ops/quota/intents/quota_operator_intent%3Aother",
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "quota-intent-not-found" },
    });
  });

  test("ops workspace endpoint rejects a participant-safe view", async () => {
    const reads: QuotaReadPort = {
      async getWorkspace() {
        return {
          kind: "ok",
          view: {
            format_version: 1,
            view: "participant",
            viewer: { subject: "operator-123", capabilities: [] },
            workspace: {
              id: "workspace:demo",
              slug: "demo",
              name: "Demo",
            },
            actions: ["contact_workspace_admin"],
          },
        };
      },
      async getBillingAccount() {
        return { kind: "not_found" };
      },
    };
    const app = createApp({
      quotaReadService: reads,
      quotaOperatorIntents: {
        async submitOperatorIntent() {
          throw new Error("not used");
        },
      },
      quotaIntentStatus: noStatus,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request("http://localhost/api/ops/quota/workspaces/demo"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "quota-ops-workspace-not-found" },
    });
  });
});

const EMPLOYEE_BUDGET_BYTES = 48 * 1024; // 运营仓 src/response-budget.ts:13，员工通道单次答复上限
const RESPONSE_FRAME_BYTES = 256; // 运营仓 src/response-budget.ts:31
const WIDE_RECORD_ROWS = 400; // 与 quota-ops-preflight.test.ts 宽工作区用例同规模（400 个 record 资源），复现线上超预算的完整视图（线上实测 58999 字节）
const BASELINE_FIELDS = [
  "kind",
  "workspace",
  "format_version",
  "current_plan",
  "target_plan",
  "before_digest",
  "usage_trusted",
  "stale",
  "observed_at",
  "effective_at",
  "required_capability",
  "affected_capabilities",
  "overage_count",
] as const;
const opsIssuer = "https://idp.example.test/issuer";
const opsAudience = "https://ops.example.test/mcp";
const clientAudience = "https://auth.example.test";

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * 运营仓 src/response-budget.ts 的 answerBytes 口径（第 55–57、65–67 行）：答复的 JSON 同时以
 * content[0].text（JSON 文本）与 structuredContent 两份计量，再加 RESPONSE_FRAME_BYTES。
 * 这比单份 JSON 字节更严，测试两种口径都断言。
 */
function answerBytes(data: unknown): number {
  const value = data === undefined ? null : data;
  return utf8Bytes(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ok: true, data: value },
  })) + RESPONSE_FRAME_BYTES;
}

const wideTargetPlan: QuotaOpsPlanRevision = {
  id: "quota_plan_revision:wide_v1",
  plan_key: "wide",
  plan_name: "Wide",
  revision: 1,
  template_kind: "commercial",
  published_at: "2026-07-01T00:00:00.000Z",
  rules: [
    {
      rule_key: "record/ent",
      resource: "record",
      label: "实体记录",
      description: "ent 开头的每张表",
      selector: { kind: "regex", value: "^ent_" },
      limit: { kind: "finite", value: 50 },
    },
    {
      rule_key: "table/orders",
      resource: "table",
      label: "订单表",
      description: "订单表不限",
      selector: { kind: "exact", value: "orders" },
      limit: { kind: "unlimited" },
    },
  ],
};

type QuotaRow = QuotaApiOperatorView["resources"][number];

// 代表性多资源工作区：大量 record 行（每三行一个未知用量、其余跨越限额两侧）、一张不限的表、一张未纳入套餐的表。
const wideRows: QuotaRow[] = [
  ...Array.from({ length: WIDE_RECORD_ROWS }, (_, index): QuotaRow => ({
    key: `record/ent_${index}`,
    resource: "record",
    label: `实体记录 · ent_${index}`,
    selector: {
      kind: "regex",
      description: "ent 开头的每张表",
      pattern: "^ent_",
      matched_tables: [`ent_${index}`],
    },
    usage: {
      kind: "finite",
      limit: 100,
      used: index % 3 === 0 ? null : (index * 7) % 120,
      remaining: null,
      over_by: null,
      utilization_percent: null,
      at_limit: null,
      over_limit: null,
    },
  })),
  {
    key: "table/orders",
    resource: "table",
    label: "业务表 · orders",
    selector: { kind: "exact", description: "固定表 orders", table: "orders" },
    usage: { kind: "unlimited", used: 500, utilization_percent: null, at_limit: false, over_limit: false },
  },
  {
    key: "table/legacy",
    resource: "table",
    label: "业务表 · legacy",
    selector: { kind: "exact", description: "固定表 legacy", table: "legacy" },
    usage: {
      kind: "finite",
      limit: 10,
      used: 3,
      remaining: null,
      over_by: null,
      utilization_percent: null,
      at_limit: null,
      over_limit: null,
    },
  },
];

const wideView: QuotaApiOperatorView = {
  format_version: 1,
  view: "operator",
  viewer: { subject: "operator", capabilities: ["quota.read"] },
  workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
  statuses: {
    sync: "in_sync",
    compliance: "compliant",
    capacity: "normal",
    service_mode: "standard",
    ledger: "ready",
  },
  observed_at: "2026-07-29T12:00:00.000Z",
  commercial_state_at: "2026-07-29T11:59:00.000Z",
  cache_age_ms: 0,
  usage_trusted: true,
  stale: false,
  applied: {
    source: "paid",
    plan_key: "pro",
    plan_name: "Pro",
    plan_revision: 2,
    entitlement_revision: 3,
    effective_at: "2026-07-01T00:00:00.000Z",
    effective_until: null,
    adjustment: null,
  },
  desired: null,
  billing_account: null,
  resources: wideRows,
  actions: ["refresh"],
  operator: {
    capabilities: [],
    workspace_record: "workspace:demo",
    database: "ws_demo",
    billing_account_record: "billing_account:acme",
    billing_account_key: "acme",
    current_subscription: "quota_subscription:sub",
    desired_entitlement: null,
    applied_entitlement: "resource_entitlement:pro",
    desired_projection: null,
    applied_projection: "quota_policy_projection:pro",
    native_generation: 3,
    native_digest: "digest-pro",
    drift_error_code: null,
    auto_reconcile: true,
  },
};

// 能力表同时供给中间件（至少一项能力）与预检服务（按意图要求的能力逐项判断）。
const capabilitiesBySubject: Readonly<Record<string, readonly PlatformOperatorCapability[]>> = {
  "operator:ada": ["quota.read", "subscription.manage", "override.manage"],
  "operator:reader": ["quota.read"],
};

const subscriptionUpsertBody = {
  kind: "subscription_upsert",
  workspaceSlug: "demo",
  workspace: "workspace:demo",
  effectiveAt: "2026-08-01T00:00:00.000Z",
  input: { plan_revision: wideTargetPlan.id },
};

const planConsole: QuotaOpsConsolePort = {
  async getContext() {
    throw new Error("not used");
  },
  async search() {
    throw new Error("not used");
  },
  async getTimeline() {
    throw new Error("not used");
  },
  async findPlanRevision({ id }) {
    return id.toString() === wideTargetPlan.id ? wideTargetPlan : null;
  },
};

async function refusal(response: Response): Promise<{ status: number; code: string | undefined }> {
  const body = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: body.error?.code };
}

describe("quota preflight summary through the real operator chain", () => {
  let privateKey: CryptoKey;
  let jwksServer: ReturnType<typeof Bun.serve>;
  let originalEnv: typeof env;
  let app: ReturnType<typeof createApp>;
  const freshActors: string[] = [];

  async function signToken(subject: string, audience = opsAudience): Promise<string> {
    return new SignJWT({ email: "ada@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "ops-key" })
      .setIssuer(opsIssuer)
      .setAudience(audience)
      .setSubject(subject)
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  function postPreflight(token: string, body: Record<string, unknown>) {
    return app.fetch(new Request("http://localhost/api/ops/quota/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));
  }

  beforeAll(async () => {
    originalEnv = env;
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    privateKey = keyPair.privateKey;
    const publicJwk: JWK = { ...(await exportJWK(keyPair.publicKey)), kid: "ops-key", alg: "RS256", use: "sig" };
    // 端口 0 由系统分配，避免与其他测试文件的固定端口冲突；getJwks 按 URL 缓存，换端口即换缓存。
    jwksServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/jwks"
          ? Response.json({ keys: [publicJwk] })
          : new Response("not found", { status: 404 });
      },
    });
    overrideEnv({
      NODE_ENV: "test",
      OIDC_ISSUER: opsIssuer,
      OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.port}/jwks`,
      OIDC_AUDIENCE: clientAudience,
      OIDC_OPS_AUDIENCE: opsAudience,
    });
    const reader: PlatformOperatorCapabilityReader = {
      async getCapabilities(subject) {
        return capabilitiesBySubject[subject] ?? [];
      },
    };
    const freshReads: QuotaOpsFreshReadPort = {
      async getOperatorWorkspaceFresh({ actor }) {
        freshActors.push(actor.subject);
        return {
          ...wideView,
          operator: { ...wideView.operator, capabilities: capabilitiesBySubject[actor.subject] ?? [] },
        };
      },
    };
    app = createApp({
      quotaReadService: noReads,
      quotaOperatorIntents: {
        async submitOperatorIntent() {
          throw new Error("not used");
        },
      },
      quotaIntentStatus: noStatus,
      quotaOpsPreflight: new QuotaOpsPreflightService(freshReads, planConsole),
      // 与生产同一条链：requirePlatformOperator 验签并实时读能力，只替换能力数据源与活性检查。
      requireUser: () => requirePlatformOperator(undefined, { reader, tokenActivityChecker: async () => true }),
    });
  });

  afterAll(() => {
    jwksServer.stop(true);
    overrideEnv(originalEnv);
  });

  test("summary keeps the 13 baseline fields equal to the full view for the same input", async () => {
    const token = await signToken("operator:ada");
    const fullResponse = await postPreflight(token, subscriptionUpsertBody);
    expect(fullResponse.status).toBe(200);
    const full = (await fullResponse.json()) as QuotaOpsIntentPreflightView;
    const summaryResponse = await postPreflight(token, { ...subscriptionUpsertBody, view: "summary" });
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as QuotaOpsIntentPreflightSummaryView;

    expect(Object.keys(full).sort()).toEqual([...BASELINE_FIELDS, "resources"].sort());
    expect(Object.keys(summary).sort()).toEqual([...BASELINE_FIELDS, "resources", "view"].sort());
    for (const field of BASELINE_FIELDS) {
      expect(summary[field]).toEqual(full[field]);
    }
    expect(summary.view).toBe("summary");
    expect(full.overage_count).toBeGreaterThan(0);
    expect(summary.resources.reduce((total, group) => total + group.rows, 0)).toBe(full.resources.length);

    // 显式 view:"full" 与不传 view 的答复逐字节一致。
    const explicitFull = await postPreflight(token, { ...subscriptionUpsertBody, view: "full" });
    expect(await explicitFull.json()).toEqual(full);
  });

  test("wide workspace: full view exceeds the budget, summary fits the employee shell", async () => {
    const token = await signToken("operator:ada");
    const fullResponse = await postPreflight(token, subscriptionUpsertBody);
    expect(fullResponse.status).toBe(200);
    const fullText = await fullResponse.text();
    expect(utf8Bytes(fullText)).toBeGreaterThan(EMPLOYEE_BUDGET_BYTES);
    const full = JSON.parse(fullText) as QuotaOpsIntentPreflightView;
    expect(full.resources).toHaveLength(WIDE_RECORD_ROWS + 2);

    const summaryResponse = await postPreflight(token, { ...subscriptionUpsertBody, view: "summary" });
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as QuotaOpsIntentPreflightSummaryView;
    // 员工通道外壳形状 { status, ok, body }：运营仓 src/ops/broker.ts:1799 返回的 value。
    // body 由 broker.ts:1796 原样交给 product()（broker.ts:1493–1495），product.ts:70–71 原样 JSON.stringify，不过滤 view 字段；
    // 运营仓 tests/ops-broker.test.ts:533–534 已验证 POST body 到达产品侧（tests/support/ops-world.ts:749 读取 body.workspaceSlug）。
    // 返回前另经 redactJson（src/ops/redact.ts:15–25，只改写秘密字段名、JWT 形状与已知秘密值，本视图的键与值都不命中）
    // 与 clipJson（broker.ts:1901–1904，超 100_000 字符才截断，本视图远低于此），两者对本视图都不改写。
    const shell = (body: unknown) => ({ status: 200, ok: true, body });
    expect(utf8Bytes(JSON.stringify(shell(full)))).toBeGreaterThan(EMPLOYEE_BUDGET_BYTES);
    expect(utf8Bytes(JSON.stringify(shell(summary)))).toBeLessThan(EMPLOYEE_BUDGET_BYTES);
    expect(answerBytes(shell(full))).toBeGreaterThan(EMPLOYEE_BUDGET_BYTES);
    expect(answerBytes(shell(summary))).toBeLessThan(EMPLOYEE_BUDGET_BYTES);
  });

  test("an invalid view value is a 400 and reads nothing", async () => {
    const token = await signToken("operator:ada");
    const before = freshActors.length;
    const response = await postPreflight(token, { ...subscriptionUpsertBody, view: "bogus" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "quota-preflight-view-invalid" } });
    expect(freshActors).toHaveLength(before);
  });

  test("missing preflight capability, no capability and a foreign audience are refused alike by both views", async () => {
    const identities = [
      // 运营身份有 quota.read 但缺 subscription.manage：预检服务返回 null，路由 404（quota-ops-preflight.ts:278–279，ops-quota.ts:288–293）。
      { token: await signToken("operator:reader"), status: 404, code: "quota-intent-preflight-not-found" },
      // 没有任何能力：中间件在进入路由前拒绝（operator-auth.ts:111–113）。
      { token: await signToken("operator:nobody"), status: 403, code: "platform-operator-inactive" },
      // 运营 audience 以外的令牌：验签阶段拒绝（operator-auth.ts:44）。
      { token: await signToken("operator:ada", clientAudience), status: 401, code: "oidc-ops-audience-invalid" },
    ];
    for (const identity of identities) {
      const full = await refusal(await postPreflight(identity.token, subscriptionUpsertBody));
      const summary = await refusal(await postPreflight(identity.token, { ...subscriptionUpsertBody, view: "summary" }));
      expect(full).toEqual({ status: identity.status, code: identity.code });
      expect(summary).toEqual(full);
    }
  });
});
