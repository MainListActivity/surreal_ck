import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { SurrealOpsRunStore } from "./store";
import { OpsRunService } from "./service";
import { ExternalOpsAgentRunner, type OpsMcpPort } from "./runner";
import { OpsAutonomyService } from "../ops-autonomy/service";
import { SurrealOpsAutonomyStore } from "../ops-autonomy/store";
import { OpsFollowUpService } from "../ops-follow-up/service";
import { SurrealOpsFollowUpStore } from "../ops-follow-up/store";
import { OpsProposalService } from "../ops-proposal/service";
import { SurrealOpsProposalStore } from "../ops-proposal/store";
import { InMemoryPlatformContentStore, PlatformContentService } from "../content/service";
import { createContentMcpRoutes } from "../ops/mcp/routes";
import { Hono } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";

const enabled = process.env.RUN_LOCAL_SURREALDB_OPS_RUN_TESTS === "1";
const localTest = test.skipIf(!enabled);
let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}
async function session(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "main", database });
  sessions.push(db);
  return db;
}
beforeAll(async () => {
  if (!enabled) return;
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn(["surreal", "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = Bun.spawn(["surreal", "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  await ensureSystemSchema(await session("_system"), { namespace: "main" });
});
afterAll(async () => {
  await Promise.all(sessions.map((db) => db.close()));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});
describe("ops agent run Surreal store", () => {
  localTest("检查点可跨连接恢复，版本竞争只允许一个写入", async () => {
    const store = new SurrealOpsRunStore(async (database) => await session(database), "main");
    const base = { runKey: "daily-run-001", workspaceSlug: "team-a", expectedVersion: null, status: "running" as const,
      cursor: null, processedIds: [], pendingAction: null, dueCheckAt: null, retryCount: 0, lastErrorCode: null, actionsCompleted: 0 };
    const first = await store.save("agent-1", base);
    expect(first).toMatchObject({ version: 1, status: "running" });
    const other = new SurrealOpsRunStore(async (database) => await session(database), "main");
    expect((await other.get("agent-1", "team-a", "daily-run-001"))?.runId).toBe(first?.runId);
    const changed = await other.save("agent-1", { ...base, expectedVersion: 1, status: "waiting", cursor: "opaque-cursor", processedIds: ["opportunity:1"],
      pendingAction: { tool: "create_follow_up", targetId: "opportunity:2", idempotencyKey: "action-0001", argsJson: "{}" } });
    expect(changed).toMatchObject({ version: 2, status: "waiting", cursor: "opaque-cursor", processedIds: ["opportunity:1"] });
    expect(await store.save("agent-1", { ...base, expectedVersion: 1 })).toBeNull();
    expect((await store.list())[0]?.pendingAction?.idempotencyKey).toBe("action-0001");
  }, 30_000);
  localTest("固定判断器通过真实 MCP 与领域服务完成发现、认领、待审建议和恢复", async () => {
    const root = sessions[0]!;
    await root.query(`CREATE platform_operator:runner SET subject = "agent-runner", kind = "agent", status = "active";
      CREATE platform_operator_capability:runner_read SET operator = platform_operator:runner, capability = "activation.followup.read", status = "active", granted_by_subject = "admin";
      CREATE platform_operator_capability:runner_write SET operator = platform_operator:runner, capability = "activation.followup.write", status = "active", granted_by_subject = "admin";
      CREATE platform_operator_capability:runner_proposal_read SET operator = platform_operator:runner, capability = "activation.proposal.read", status = "active", granted_by_subject = "admin";
      CREATE platform_operator_capability:runner_proposal_submit SET operator = platform_operator:runner, capability = "activation.proposal.submit", status = "active", granted_by_subject = "admin";
      CREATE workspace:runner SET db_name = "ws_runner", owner_subject = "admin", slug = "team-runner", name = "Runner", status = "active";
      CREATE workspace_activation_summary:runner SET workspace = workspace:runner, workspace_slug = "team-runner", contract_version = "2", dedupe_key = "runner-period",
        status = "active", supplied_by_subject = "admin", supplied_at = time::now(),
        content = { contractVersion: "2", period: { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", timeZone: "UTC" },
          stage: "incomplete", progress: {}, outcomes: {}, updatedAt: "2026-09-22T12:00:00.000Z", dedupeKey: "runner-period" };`).collect();
    const autonomy = new OpsAutonomyService(new SurrealOpsAutonomyStore(async (database) => await session(database), "main"));
    const caps = ["activation.followup.read", "activation.followup.write", "activation.proposal.read", "activation.proposal.submit"];
    await autonomy.configure({ subject: "admin", kind: "human", capabilities: ["activation.autonomy.read", "activation.autonomy.manage", ...caps] }, {
      agentSubject: "agent-runner", workspaceSlug: "team-runner", expectedVersion: null,
      actions: ["opportunity.read", "follow_up.create", "follow_up.claim", "follow_up.read", "proposal.submit", "proposal.read"],
      idempotencyKey: "runner-policy-001",
    });
    const followUps = new OpsFollowUpService(new SurrealOpsFollowUpStore(async (database) => await session(database), "main"), undefined, autonomy);
    const proposals = new OpsProposalService(new SurrealOpsProposalStore(async (database) => await session(database), "main"), followUps, autonomy);
    const runs = new OpsRunService(new SurrealOpsRunStore(async (database) => await session(database), "main"), autonomy);
    const content = new PlatformContentService({ store: new InMemoryPlatformContentStore(), sources: [] });
    const app = new Hono<AppBindings>();
    app.onError(handleError);
    app.route("/", createContentMcpRoutes({ service: content, opsFollowUpService: followUps, opsProposalService: proposals,
      opsAutonomyService: autonomy, opsRunService: runs, authorizationServer: "https://auth.example.test",
      requireOperator: async (c, next) => {
        c.set("user", { subject: "agent-runner", raw: { scope: caps.join(" ") }, rawToken: "test-token" });
        c.set("platformOperator", { subject: "agent-runner", kind: "agent", capabilities: caps });
        await next();
      },
    }));
    let sequence = 0;
    const port: OpsMcpPort = { async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      const response = await app.request("/api/ops/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: tool, arguments: args } }) });
      const body = await response.json() as { result?: { structuredContent?: T & { error?: { code: string; message: string } } }; error?: unknown };
      const result = body.result?.structuredContent;
      if (!response.ok || !result || result.error) throw Object.assign(new Error(result?.error?.message ?? "MCP tool failed"), { code: result?.error?.code ?? "mcp_error" });
      return result;
    } };
    const runner = new ExternalOpsAgentRunner(port);
    const done = await runner.run({ runKey: "daily-runner-001", workspaceSlug: "team-runner" });
    expect(done.status).toBe("waiting");
    expect(done.actionsCompleted).toBe(3);
    expect((await proposals.list({ subject: "agent-runner", kind: "agent", capabilities: caps }, {})).items[0]).toMatchObject({ status: "pending", triggerReason: "fresh_activation_opportunity" });
    expect((await runner.run({ runKey: "daily-runner-001", workspaceSlug: "team-runner" })).actionsCompleted).toBe(3);
  }, 30_000);
});
