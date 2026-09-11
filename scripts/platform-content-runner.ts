import { readFile, rename, writeFile } from "node:fs/promises";
import { IngestionBatchSchema, type IngestionBatch } from "../shared/src/platform-content/contracts";
import { createSyntheticJudgmentBatch } from "../shared/src/platform-content/fixtures";

type JsonObject = Record<string, unknown>;

type Checkpoint = {
  idempotencyKey: string;
  batchId: string;
  submittedAt: string;
  inspectedAt?: string;
  publishedAt?: string;
  status?: string;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const checkpointPath = process.env.CONTENT_CHECKPOINT_FILE || ".content-runner-checkpoint.json";
const mcpUrl = process.env.CONTENT_MCP_URL?.trim() || "";
const accessToken = process.env.CONTENT_ACCESS_TOKEN?.trim() || "";
let requestId = 0;

function flag(name: string): boolean {
  return Bun.argv.slice(2).includes(name);
}

function required(name: string, value: string): string {
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 返回格式无效`);
  return value as JsonObject;
}

function resultValue(result: JsonObject): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item && typeof item === "object" && (item as JsonObject).type === "text") as JsonObject | undefined
    : undefined;
  if (typeof text?.text !== "string") return result;
  try {
    return JSON.parse(text.text);
  } catch {
    return { text: text.text };
  }
}

async function rpc(method: string, params: JsonObject = {}): Promise<JsonObject> {
  const response = await fetch(required("CONTENT_MCP_URL", mcpUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${required("CONTENT_ACCESS_TOKEN", accessToken)}`,
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const envelope = asObject(body, `MCP ${method}`);
  if (envelope.error) {
    const error = asObject(envelope.error, `MCP ${method} error`);
    throw new Error(`MCP ${String(error.code ?? "error")}: ${String(error.message ?? "请求失败")}`);
  }
  const result = asObject(envelope.result, `MCP ${method}`);
  if (result.isError === true) {
    const value = asObject(resultValue(result), `MCP ${method} business error`);
    const error = value.error && typeof value.error === "object" ? asObject(value.error, "MCP business error") : value;
    throw new Error(`MCP ${String(error.code ?? "error")}: ${String(error.message ?? "工具执行失败")}`);
  }
  return asObject(resultValue(result), `MCP ${method} result`);
}

async function callTool(name: string, args: JsonObject): Promise<JsonObject> {
  return rpc("tools/call", { name, arguments: args });
}

async function loadCheckpoint(): Promise<Checkpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(checkpointPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const checkpoint = parsed as Partial<Checkpoint>;
    return typeof checkpoint.idempotencyKey === "string" && typeof checkpoint.batchId === "string" && typeof checkpoint.submittedAt === "string"
      ? checkpoint as Checkpoint
      : null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await rename(temporaryPath, checkpointPath);
}

async function loadBatch(): Promise<IngestionBatch> {
  if (flag("--fixture")) return createSyntheticJudgmentBatch();
  const inputPath = process.env.CONTENT_BATCH_FILE?.trim();
  if (!inputPath) throw new Error("请配置 CONTENT_BATCH_FILE，或使用 --fixture");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  } catch {
    throw new Error(`无法读取批次文件：${inputPath}`);
  }
  const parsed = IngestionBatchSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`批次文件不符合契约：${parsed.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")}`);
  return parsed.data;
}

async function inspectBatch(batchId: string): Promise<JsonObject> {
  const entries: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await callTool("inspect_batch", { batchId, cursor, limit: 100 });
    if (Array.isArray(response.entries)) entries.push(...response.entries);
    const next = response.nextCursor;
    cursor = typeof next === "string" && next.length > 0 ? next : null;
    if (!cursor) return { ...response, entries };
  }
  throw new Error("批次分页超过安全上限");
}

async function main(): Promise<void> {
  const batch = await loadBatch();
  await rpc("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "surreal-ck-local-runner", version: "1.0.0" },
  });
  const contract = await callTool("get_data_contract", {});
  if (contract.contractVersion !== "1") throw new Error(`不支持的数据契约版本：${String(contract.contractVersion ?? "unknown")}`);

  const force = flag("--force");
  const previous = await loadCheckpoint();
  if (!force && previous && previous.idempotencyKey !== batch.idempotencyKey) {
    throw new Error(`检查点属于另一幂等键 ${previous.idempotencyKey}，请使用 --force 或更换 CONTENT_CHECKPOINT_FILE`);
  }

  const submitted = await callTool("submit_batch", batch as unknown as JsonObject);
  const batchId = typeof submitted.batchId === "string" ? submitted.batchId : previous?.batchId;
  if (!batchId) throw new Error("submit_batch 未返回 batchId");
  const checkpoint: Checkpoint = {
    idempotencyKey: batch.idempotencyKey,
    batchId,
    submittedAt: previous?.submittedAt ?? new Date().toISOString(),
    status: typeof submitted.status === "string" ? submitted.status : undefined,
  };
  await saveCheckpoint(checkpoint);

  const inspected = await inspectBatch(batchId);
  checkpoint.inspectedAt = new Date().toISOString();
  checkpoint.status = typeof inspected.status === "string" ? inspected.status : checkpoint.status;
  await saveCheckpoint(checkpoint);

  const publishable = Array.isArray(inspected.entries)
    ? inspected.entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const value = entry as JsonObject;
        return value.status === "ready" && typeof value.entryKey === "string" ? [value.entryKey] : [];
      })
    : [];

  if (!flag("--publish")) {
    console.log(JSON.stringify({ mode: "review_required", contractVersion: contract.contractVersion, batchId, status: inspected.status, entryCount: Array.isArray(inspected.entries) ? inspected.entries.length : 0, publishableEntryKeys: publishable }, null, 2));
    return;
  }
  if (process.env.CONTENT_PUBLISH_CONFIRM !== "YES") throw new Error("发布需要显式设置 CONTENT_PUBLISH_CONFIRM=YES；默认停在人工审阅");
  if (publishable.length === 0) throw new Error("没有可发布条目；请先在运营端处理失败或阻塞项");
  const published = await callTool("publish_batch", {
    batchId,
    validationRevision: inspected.validationRevision,
    entryKeys: publishable,
    idempotencyKey: `${batch.idempotencyKey}:publish`,
  });
  checkpoint.publishedAt = new Date().toISOString();
  checkpoint.status = typeof published.status === "string" ? published.status : checkpoint.status;
  await saveCheckpoint(checkpoint);
  console.log(JSON.stringify({ mode: "published", batchId, status: published.status, entries: published.entries }, null, 2));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "本地内容 runner 执行失败");
  process.exitCode = 1;
});
