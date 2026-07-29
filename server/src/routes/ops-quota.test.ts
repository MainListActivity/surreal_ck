import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { StringRecordId } from "surrealdb";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { QuotaIntentStatusReader } from "../quota/quota-intent-status";
import type { OperatorIntentSubmission } from "../quota/subscription-lifecycle";
import type {
  QuotaOperatorIntentPort,
} from "./ops-quota";
import type { QuotaReadPort } from "./quota";
import type { QuotaOpsPreflightPort } from "../quota/quota-ops-preflight";

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
