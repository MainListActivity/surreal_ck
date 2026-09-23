import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExternalOpsAgentRunner, type OpsMcpPort } from "../src/ops-run/runner";

const mcpUrl = process.env.OPS_MCP_URL;
const accessToken = process.env.OPS_AGENT_ACCESS_TOKEN;
const workspaceSlug = process.env.OPS_AGENT_WORKSPACE;
const runKey = process.env.OPS_AGENT_RUN_KEY ?? `daily-${workspaceSlug ?? "unknown"}`;
if (!mcpUrl || !accessToken || !workspaceSlug) throw new Error("OPS_MCP_URL、OPS_AGENT_ACCESS_TOKEN 和 OPS_AGENT_WORKSPACE 必填");

const client = new Client({ name: "surreal-ck-external-ops-runner", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
});
await client.connect(transport);
const mcp: OpsMcpPort = {
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError || content?.error) {
      const error = content?.error as { code?: string; message?: string } | undefined;
      throw Object.assign(new Error(error?.message ?? `${tool} failed`), { code: error?.code ?? "mcp_error" });
    }
    if (content === undefined) throw new Error(`${tool} returned no structuredContent`);
    return content as T;
  },
};
try {
  const runner = new ExternalOpsAgentRunner(mcp);
  const result = await runner.run({ runKey, workspaceSlug,
    budget: {
      maxActions: Number(process.env.OPS_AGENT_MAX_ACTIONS ?? 20),
      maxRetries: Number(process.env.OPS_AGENT_MAX_RETRIES ?? 3),
      maxDurationMs: Number(process.env.OPS_AGENT_MAX_DURATION_MS ?? 60_000),
      intervalMs: Number(process.env.OPS_AGENT_INTERVAL_MS ?? 3_600_000),
    },
  });
  process.stdout.write(JSON.stringify({ runKey: result.runKey, workspaceSlug: result.workspaceSlug, status: result.status,
    actionsCompleted: result.actionsCompleted, updatedAt: result.updatedAt }) + "\n");
  if (result.status === "needs_human") process.exitCode = 2;
} finally {
  await client.close();
}
