import { expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { RecordId } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createInternalAiIdentityRoutes } from "./internal-ai-identity";

const caller: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", { subject: "fixture-caller", rawToken: "synthetic-not-a-token", db: "ws_fixture", ac: "participant", roles: [] });
  await next();
};
function fixture(options: { billingRole?: string; workspaceRole?: string; missing?: number; subscriptionStatus?: string; accountStatus?: string } = {}) {
  const calls: Array<{ sql: string; vars?: Record<string, unknown> }> = [];
  const results = [
    [{ id: new RecordId("workspace", "fixture"), db_name: "ws_fixture", status: "active" }],
    [{ role: options.workspaceRole ?? "participant" }],
    [{ subscription: { status: options.subscriptionStatus ?? "active", billing_account: { id: new RecordId("billing_account", "fixture"), account_key: "fixture-account", status: options.accountStatus ?? "active" } } }],
    options.billingRole ? [{ role: options.billingRole }] : [],
  ];
  const app = new Hono<AppBindings>().route("/", createInternalAiIdentityRoutes({ requireUser: caller, db: async () => ({
    async query(sql, vars) { const index = calls.length; calls.push({ sql, vars }); return [index === options.missing ? [] : results[index]]; },
  }) })).onError(handleError);
  return { app, calls };
}
test("identity requires normal OIDC; does not accept subject or arbitrary query parameters", async () => {
  const app = new Hono<AppBindings>().route("/", createInternalAiIdentityRoutes({ db: async () => { throw new Error("unreachable"); } })).onError(handleError);
  expect((await app.request("/api/internal-ai/identity?workspaceSlug=fixture")).status).toBe(401);
  const f = fixture();
  expect((await f.app.request("/api/internal-ai/identity?workspaceSlug=fixture&subject=other")).status).toBe(400);
  expect((await f.app.request("/api/internal-ai/identity")).status).toBe(400);
  expect(f.calls).toHaveLength(0);
});
test("workspace and billing roles are independent; owner does not follow workspace admin", async () => {
  for (const [billingRole, workspaceRole, expected] of [["owner", "participant", "owner"], ["viewer", "admin", "member"], [undefined, "admin", "member"]] as const) {
    const f = fixture({ billingRole, workspaceRole });
    const response = await f.app.request("/api/internal-ai/identity?workspaceSlug=fixture");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ subject: "fixture-caller", spaceId: "workspace:fixture", database: "ws_fixture", workspaceRole, billingRole: expected, billingAccountRef: "fixture-account" });
    expect(f.calls[1]?.vars?.subject).toBe("fixture-caller");
    expect(f.calls[3]?.vars?.subject).toBe("fixture-caller");
  }
});
test("nonmember, missing active subscription/account, billing admin and malformed authority fail closed", async () => {
  for (const options of [{ missing: 0 }, { missing: 1 }, { missing: 2 }, { billingRole: "admin" }, { billingRole: "unknown" }, { workspaceRole: "owner" }, { subscriptionStatus: "paused" }, { accountStatus: "closed" }]) {
    const { app } = fixture(options);
    const response = await app.request("/api/internal-ai/identity?workspaceSlug=fixture");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "internal-ai-identity-unavailable" } });
  }
});
