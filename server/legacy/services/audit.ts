import { getLocalDb } from "../db/index";
import { getServiceContext } from "./context";

type ClientErrorMeta = {
  screen?: string;
  workbookId?: string;
  [key: string]: unknown;
};

export type AiToolCallAuditInput = {
  sessionId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
};

const SENSITIVE_KEYS = /api[-_]?key|authorization|password|prompt|secret|token/i;
const IDENTIFIER_KEYS = new Set([
  "dashboardId",
  "fieldKey",
  "recordId",
  "route",
  "sheetId",
  "table",
  "toolName",
  "workbookId",
  "workspaceId",
]);

/** 记录客户端侧的服务错误，写入 client_error 表，失败静默。 */
export async function recordClientError(
  errorCode: string,
  message: string,
  meta?: ClientErrorMeta
): Promise<void> {
  try {
    const ctx = getServiceContext();
    if (!ctx.isAuthenticated) return;

    const db = getLocalDb();
    await db.query(
      `CREATE client_error CONTENT {
        error_code: $code,
        message: $msg,
        meta: $meta,
        created_at: time::now()
      }`,
      { code: errorCode, msg: message, meta: meta ?? {} }
    );
  } catch {
    // 审计失败不应影响主流程
  }
}

/** 记录 Mastra tool 调用摘要；只保留意图类型和关键标识符，避免 prompt/API key/行数据进入审计。 */
export async function recordAiToolCall(input: AiToolCallAuditInput): Promise<void> {
  const intentType = extractIntentType(input.result);
  const identifiers = {
    ...extractIdentifiers(input.args),
    ...extractIdentifiers(input.result),
  };

  await recordClientError("AI_TOOL_CALL", `${input.toolName}:${intentType}`, {
    sessionId: input.sessionId,
    toolName: input.toolName,
    intentType,
    identifiers,
    argsSummary: summarizeArgs(input.args),
    timestamp: new Date().toISOString(),
  });
}

function extractIntentType(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  const intent = value.intent;
  if (isRecord(intent) && typeof intent.type === "string") return intent.type;
  if (typeof value.type === "string") return value.type;
  return "unknown";
}

function summarizeArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    if (IDENTIFIER_KEYS.has(key) || key === "query" || key === "description") {
      summary[key] = summarizeValue(item);
    }
  }
  return summary;
}

function extractIdentifiers(value: unknown): Record<string, string> {
  const identifiers: Record<string, string> = {};
  visitRecords(value, (key, item) => {
    if (!IDENTIFIER_KEYS.has(key)) return;
    if (typeof item === "string" || typeof item === "number") {
      identifiers[key] = String(item);
    }
  });
  return identifiers;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 80);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return { count: value.length };
  if (isRecord(value)) return { keys: Object.keys(value).filter((key) => !SENSITIVE_KEYS.test(key)).slice(0, 10) };
  return undefined;
}

function visitRecords(value: unknown, visitor: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitRecords(item, visitor);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    visitor(key, item);
    visitRecords(item, visitor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
