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

/** MCP 端点级失败（含 401 未授权）；调用方据此停止后续远端操作。 */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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

/** MCP 连接信息（显式传参，避免模块级环境耦合）。 */
type McpConnection = Readonly<{ mcpUrl: string; accessToken: string }>;

async function rpc(connection: McpConnection, fetchImpl: typeof fetch, method: string, params: JsonObject = {}): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetchImpl(required("CONTENT_MCP_URL", connection.mcpUrl), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${required("CONTENT_ACCESS_TOKEN", connection.accessToken)}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
  } catch (error) {
    throw new McpHttpError(0, `MCP 网络失败：${error instanceof Error ? error.message : "unknown"}`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new McpHttpError(response.status, `MCP HTTP ${response.status}`);
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

async function callTool(connection: McpConnection, fetchImpl: typeof fetch, name: string, args: JsonObject): Promise<JsonObject> {
  return rpc(connection, fetchImpl, "tools/call", { name, arguments: args });
}

export async function loadCheckpoint(path: string): Promise<Checkpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const checkpoint = parsed as Partial<Checkpoint>;
    return typeof checkpoint.idempotencyKey === "string" && typeof checkpoint.batchId === "string" && typeof checkpoint.submittedAt === "string"
      ? checkpoint as Checkpoint
      : null;
  } catch {
    return null;
  }
}

export async function saveCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
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

async function inspectBatch(connection: McpConnection, fetchImpl: typeof fetch, batchId: string): Promise<JsonObject> {
  const entries: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await callTool(connection, fetchImpl, "inspect_batch", { batchId, cursor, limit: 100 });
    if (Array.isArray(response.entries)) entries.push(...response.entries);
    const next = response.nextCursor;
    cursor = typeof next === "string" && next.length > 0 ? next : null;
    if (!cursor) return { ...response, entries };
  }
  throw new Error("批次分页超过安全上限");
}

/** 提交与检查点条目的公开形态（不含 token、不含原始正文）。 */
export type RunnerInspectEntry = Readonly<{ entryKey: string; status: string }>;

export type RunnerSubmitResult = Readonly<{
  contractVersion: string;
  batchId: string;
  batchStatus: string | null;
  validationRevision: unknown;
  entries: readonly RunnerInspectEntry[];
}>;

/**
 * 可复用的提交通道（LCM-09 runner 语义）：
 * initialize → 契约核对 → submit_batch（同幂等键可安全重跑）→ 原子检查点 → 分页 inspect → 检查点更新。
 * 永不发布：publish_batch 只在 CLI main 的显式 --publish 分支存在，本函数不提供发布路径。
 * MCP 401/网络失败抛 McpHttpError，由调用方停止后续远端操作。
 */
export async function submitAndInspectBatch(input: {
  mcpUrl: string;
  accessToken: string;
  batch: IngestionBatch;
  checkpointPath: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RunnerSubmitResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const connection: McpConnection = { mcpUrl: input.mcpUrl, accessToken: input.accessToken };
  await rpc(connection, fetchImpl, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "surreal-ck-local-runner", version: "1.0.0" },
    });
    const contract = await callTool(connection, fetchImpl, "get_data_contract", {});
    if (contract.contractVersion !== "1") throw new Error(`不支持的数据契约版本：${String(contract.contractVersion ?? "unknown")}`);

    const previousCheckpoint = await loadCheckpoint(input.checkpointPath);
    if (!input.force && previousCheckpoint && previousCheckpoint.idempotencyKey !== input.batch.idempotencyKey) {
      throw new Error(`检查点属于另一幂等键 ${previousCheckpoint.idempotencyKey}，请使用 --force 或更换检查点文件`);
    }

    const submitted = await callTool(connection, fetchImpl, "submit_batch", input.batch as unknown as JsonObject);
    const batchId = typeof submitted.batchId === "string" ? submitted.batchId : previousCheckpoint?.batchId;
    if (!batchId) throw new Error("submit_batch 未返回 batchId");
    const checkpoint: Checkpoint = {
      idempotencyKey: input.batch.idempotencyKey,
      batchId,
      submittedAt: previousCheckpoint?.submittedAt ?? new Date().toISOString(),
      status: typeof submitted.status === "string" ? submitted.status : undefined,
    };
    await saveCheckpoint(input.checkpointPath, checkpoint);

    const inspected = await inspectBatch(connection, fetchImpl, batchId);
    checkpoint.inspectedAt = new Date().toISOString();
    checkpoint.status = typeof inspected.status === "string" ? inspected.status : checkpoint.status;
    await saveCheckpoint(input.checkpointPath, checkpoint);

    const entries: RunnerInspectEntry[] = Array.isArray(inspected.entries)
      ? inspected.entries.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as JsonObject;
          return typeof value.entryKey === "string" && typeof value.status === "string"
            ? [{ entryKey: value.entryKey, status: value.status }]
            : [];
        })
      : [];
    return {
      contractVersion: String(contract.contractVersion),
      batchId,
      batchStatus: typeof submitted.status === "string" ? submitted.status : null,
      validationRevision: inspected.validationRevision,
      entries,
    };
}

async function main(): Promise<void> {
  const batch = await loadBatch();
  const result = await submitAndInspectBatch({
    mcpUrl,
    accessToken,
    batch,
    checkpointPath,
    force: flag("--force"),
  });

  const publishable = result.entries.filter((entry) => entry.status === "ready").map((entry) => entry.entryKey);

  if (!flag("--publish")) {
    console.log(JSON.stringify({ mode: "review_required", contractVersion: result.contractVersion, batchId: result.batchId, status: result.batchStatus, entryCount: result.entries.length, publishableEntryKeys: publishable }, null, 2));
    return;
  }
  if (process.env.CONTENT_PUBLISH_CONFIRM !== "YES") throw new Error("发布需要显式设置 CONTENT_PUBLISH_CONFIRM=YES；默认停在人工审阅");
  if (publishable.length === 0) throw new Error("没有可发布条目；请先在运营端处理失败或阻塞项");
  const published = await callTool({ mcpUrl, accessToken }, fetch, "publish_batch", {
    batchId: result.batchId,
    validationRevision: result.validationRevision,
    entryKeys: publishable,
    idempotencyKey: `${batch.idempotencyKey}:publish`,
  });
  const checkpoint = await loadCheckpoint(checkpointPath);
  if (checkpoint) {
    checkpoint.publishedAt = new Date().toISOString();
    checkpoint.status = typeof published.status === "string" ? published.status : checkpoint.status;
    await saveCheckpoint(checkpointPath, checkpoint);
  }
  console.log(JSON.stringify({ mode: "published", batchId: result.batchId, status: published.status, entries: published.entries }, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "本地内容 runner 执行失败");
    process.exitCode = 1;
  });
}
