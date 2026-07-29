import { describe, expect, test } from "bun:test";
import {
  QuotaApiError,
  loadWorkspaceQuota,
  preflightQuotaIntent,
  submitQuotaIntent,
  type QuotaEndpointClient,
  type QuotaOpsIntentDraft,
} from "./client";

function response(
  body: unknown,
  status = 200,
): Awaited<ReturnType<QuotaEndpointClient["workspace"]>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function endpoint(overrides: Partial<QuotaEndpointClient> = {}): QuotaEndpointClient {
  const notUsed = async () => response({ error: { code: "not-used" } }, 500);
  return {
    workspace: notUsed,
    billingAccount: notUsed,
    notifications: notUsed,
    markNotificationRead: notUsed,
    opsContext: notUsed,
    opsSearch: notUsed,
    opsWorkspace: notUsed,
    opsTimeline: notUsed,
    opsPreflight: notUsed,
    submitIntent: notUsed,
    intentStatus: notUsed,
    ...overrides,
  };
}

const draft: QuotaOpsIntentDraft = {
  kind: "audit_now",
  workspaceSlug: "demo",
  workspace: "workspace:demo",
  requestId: "req-1",
  customerReason: "重新核对用量",
  operatorReason: "支持工单 42",
  effectiveAt: "2026-07-29T12:00:00.000Z",
  input: { workspace: "workspace:demo" },
};

describe("quota API client", () => {
  test("workspace refresh is explicit and keeps the role-shaped DTO", async () => {
    let force = false;
    const view = {
      format_version: 1,
      view: "participant",
      viewer: { subject: "member", capabilities: [] },
      workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
      actions: ["contact_workspace_admin"],
    } as const;
    const result = await loadWorkspaceQuota("demo", true, endpoint({
      async workspace(slug, refresh) {
        expect(slug).toBe("demo");
        force = refresh;
        return response(view);
      },
    }));
    expect(force).toBe(true);
    expect(result).toEqual(view);
  });

  test("structured HTTP error is retained for stale/rate-limit UI", async () => {
    const attempt = loadWorkspaceQuota("demo", true, endpoint({
      async workspace() {
        return response({
          error: {
            code: "quota-refresh-rate-limited",
            message: "rate limited",
            details: { retryAfterMs: 8_000 },
          },
        }, 429);
      },
    }));
    expect(attempt).rejects.toBeInstanceOf(QuotaApiError);
    try {
      await attempt;
    } catch (error) {
      expect(error).toMatchObject({
        status: 429,
        code: "quota-refresh-rate-limited",
        details: { retryAfterMs: 8_000 },
      });
    }
  });

  test("preflight omits reasons while durable intent includes required audit fields", async () => {
    const calls: Array<{ phase: string; value: QuotaOpsIntentDraft }> = [];
    const client = endpoint({
      async opsPreflight(value) {
        calls.push({ phase: "preflight", value });
        return response({
          format_version: 1,
          workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
          kind: "audit_now",
          required_capability: "reconcile.audit",
          observed_at: "2026-07-29T12:00:00.000Z",
          usage_trusted: true,
          stale: false,
          effective_at: "2026-07-29T12:00:00.000Z",
          current_plan: null,
          target_plan: null,
          resources: [],
          overage_count: 0,
          affected_capabilities: ["native readback"],
          before_digest: "digest",
        });
      },
      async submitIntent(value) {
        calls.push({ phase: "submit", value });
        return response({
          id: "quota_operator_intent:req-1",
          status: "accepted",
          statusUrl: "/api/ops/quota/intents/req-1",
        });
      },
    });

    await preflightQuotaIntent(draft, client);
    await submitQuotaIntent(draft, client);
    expect(calls).toEqual([
      { phase: "preflight", value: draft },
      { phase: "submit", value: draft },
    ]);
  });
});
