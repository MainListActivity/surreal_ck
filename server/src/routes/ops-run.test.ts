import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { OpsRunService } from "../ops-run/service";
import { OpsAutonomyError } from "../ops-autonomy/service";
import { createOpsRunRoutes } from "./ops-run";

function app(kind: "agent" | "human", scope: string) {
  const items = new Map<string, any>();
  const service = new OpsRunService({
    get: async (_subject, _workspace, key) => items.get(key) ?? null,
    list: async () => [...items.values()],
    save: async (subject, input) => {
      const old = items.get(input.runKey);
      if ((old?.version ?? null) !== input.expectedVersion) return null;
      const row = { ...input, agentSubject: subject, runId: `ops_agent_run:${input.runKey}`, version: (old?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      items.set(input.runKey, row);
      return row;
    },
  }, { authorize: async (actor, _action, workspace) => {
    if (workspace !== "team-a") throw new OpsAutonomyError("out_of_scope", "workspace denied");
    if (!actor.capabilities.includes("activation.followup.read")) throw new OpsAutonomyError("capability_missing", "scope denied");
  } });
  const web = new Hono<AppBindings>();
  web.onError(handleError);
  web.route("/", createOpsRunRoutes({ service, requireOperator: () => async (c, next) => {
    c.set("platformOperator", { subject: kind === "agent" ? "agent-1" : "human-1", kind,
      capabilities: ["activation.followup.read", "activation.autonomy.read"] });
    c.set("user", { raw: { scope } } as AppBindings["Variables"]["user"]);
    await next();
  } }));
  return web;
}
const body = { runKey: "daily-run-001", workspaceSlug: "team-a", expectedVersion: null, status: "running", cursor: null,
  processedIds: [], pendingAction: null, dueCheckAt: null, retryCount: 0, lastErrorCode: null, actionsCompleted: 0 };
describe("ops run HTTP", () => {
  test("agent 报告检查点，真人只读列表；scope 收窄拒绝旧 token", async () => {
    const agent = app("agent", "activation.followup.read");
    const saved = await agent.request("/api/ops/agent-runs/checkpoint", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(saved.status).toBe(200);
    expect((await saved.json()).version).toBe(1);
    expect((await agent.request("/api/ops/agent-runs/checkpoint?workspaceSlug=team-a&runKey=daily-run-001")).status).toBe(200);
    expect((await agent.request("/api/ops/agent-runs")).status).toBe(403);
    const narrowed = app("agent", "activation.autonomy.read");
    expect((await narrowed.request("/api/ops/agent-runs/checkpoint", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await app("human", "activation.autonomy.read").request("/api/ops/agent-runs")).status).toBe(200);
  });
});
