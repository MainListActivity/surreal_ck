import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { InMemoryPlatformContentStore, PlatformContentService } from "../content/service";
import { createContentMcpRoutes } from "../ops/mcp/routes";
import { OpsAutonomyService, type OpsAutonomyStore } from "../ops-autonomy/service";
import type { OpsAutonomyPolicy } from "@surreal-ck/shared";
import { createOpsAutonomyRoutes } from "./ops-autonomy";

function fixture(scope: string) {
  let policy: OpsAutonomyPolicy | null = null;
  const store: OpsAutonomyStore = {
    async getOperatorKind() { return "agent"; },
    async getOperatorCapabilities() { return ["activation.followup.read", "activation.followup.write"]; },
    async workspaceExists() { return true; },
    async listPolicies() { return policy ? [policy] : []; },
    async listAudit() { return []; },
    async getPolicy() { return policy; },
    async getById() { return policy; },
    async findIdempotent() { return null; },
    async save(input) {
      policy = { policyId: "ops_agent_policy:one", agentSubject: input.agentSubject, workspaceSlug: input.workspaceSlug,
        actions: input.actions, status: input.status, version: (policy?.version ?? 0) + 1,
        updatedBySubject: input.actorSubject, updatedAt: "2026-09-22T12:00:00.000Z" };
      return policy;
    },
  };
  const service = new OpsAutonomyService(store);
  const authorize = (): MiddlewareHandler<AppBindings> => async (c, next) => {
    c.set("user", { subject: "ops-human", rawToken: "token", raw: { scope } });
    c.set("platformOperator", { subject: "ops-human", kind: "human", capabilities: ["activation.autonomy.read", "activation.autonomy.manage", "activation.followup.read", "activation.followup.write"] });
    await next();
  };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createOpsAutonomyRoutes({ service, requireOperator: authorize }));
  app.route("/", createContentMcpRoutes({ service: new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [] }), opsAutonomyService: service, requireOperator: authorize() }));
  return app;
}
async function mcp(app: Hono<AppBindings>, name: string, args: object) {
  const response = await app.request("/api/ops/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return (await response.json() as { result?: { structuredContent?: unknown } }).result?.structuredContent;
}
describe("ops autonomy HTTP and MCP", () => {
  test("配置与暂停在页面和 MCP 返回同一状态", async () => {
    const app = fixture("activation.autonomy.read activation.autonomy.manage activation.followup.read activation.followup.write");
    const response = await app.request("/api/ops/autonomy/policies", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: null, idempotencyKey: "policy-route-create" }) });
    expect(response.status).toBe(200);
    const created = await response.json() as OpsAutonomyPolicy;
    const listed = await mcp(app, "list_agent_policies", {});
    expect(listed).toEqual({ items: [created] });
    const paused = await mcp(app, "change_agent_policy_status", { policyId: created.policyId, expectedVersion: 1, status: "paused", reason: "临时暂停", idempotencyKey: "policy-mcp-pause" }) as OpsAutonomyPolicy;
    const fromHttp = await app.request("/api/ops/autonomy/policies");
    expect(await fromHttp.json()).toEqual({ items: [paused] });
  });
  test("OAuth scope 收窄使页面和 MCP 都不能配置", async () => {
    const app = fixture("activation.autonomy.read");
    const body = { agentSubject: "agent", workspaceSlug: "team-a", actions: ["follow_up.create"], expectedVersion: null, idempotencyKey: "policy-route-denied" };
    const response = await app.request("/api/ops/autonomy/policies", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(403);
    const denied = await mcp(app, "configure_agent_policy", body) as { error?: { code?: string } };
    expect(denied.error?.code).toBe("capability_missing");
  });
});
