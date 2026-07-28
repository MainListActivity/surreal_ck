import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import { QuotaRefreshRateLimitError } from "../quota/quota-info-cache";
import type { QuotaReadPort } from "./quota";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: {},
  rawToken: "test-token",
};

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", testUser);
  await next();
};

function participantView() {
  return {
    format_version: 1 as const,
    view: "participant" as const,
    viewer: { subject: "user-123", capabilities: [] as const },
    workspace: { id: "workspace:demo", slug: "demo", name: "Demo" },
    actions: ["contact_workspace_admin"] as const,
  };
}

describe("quota routes", () => {
  test("passes OIDC identity and explicit refresh to the workspace service", async () => {
    const calls: unknown[] = [];
    const service: QuotaReadPort = {
      async getWorkspace(input) {
        calls.push(input);
        return { kind: "ok", view: participantView() };
      },
      async getBillingAccount() {
        return { kind: "not_found" };
      },
    };
    const app = createApp({
      quotaReadService: service,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/demo/quota?refresh=true"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(participantView());
    expect(calls).toEqual([{
      slug: "demo",
      actor: { subject: "user-123", email: "ada@example.test" },
      force: true,
    }]);
  });

  test("uses indistinguishable 404 for inaccessible workspace and billing objects", async () => {
    const service: QuotaReadPort = {
      async getWorkspace() {
        return { kind: "not_found" };
      },
      async getBillingAccount() {
        return { kind: "not_found" };
      },
    };
    const app = createApp({
      quotaReadService: service,
      requireUser: () => useTestUser,
    });
    const workspace = await app.fetch(
      new Request("http://localhost/api/workspaces/secret/quota"),
    );
    const billing = await app.fetch(
      new Request("http://localhost/api/billing-accounts/secret/quota"),
    );
    expect(workspace.status).toBe(404);
    expect(billing.status).toBe(404);
    expect(await workspace.json()).toMatchObject({
      error: { code: "quota-workspace-not-found" },
    });
    expect(await billing.json()).toMatchObject({
      error: { code: "quota-billing-account-not-found" },
    });
  });

  test("maps per-actor force refresh limiting to 429 with retry-after detail", async () => {
    const service: QuotaReadPort = {
      async getWorkspace() {
        throw new QuotaRefreshRateLimitError(7_500);
      },
      async getBillingAccount() {
        return { kind: "not_found" };
      },
    };
    const app = createApp({
      quotaReadService: service,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/demo/quota?refresh=1"),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "quota-refresh-rate-limited",
        message: "Quota refresh is rate limited",
        details: { retryAfterMs: 7_500 },
      },
    });
  });
});
