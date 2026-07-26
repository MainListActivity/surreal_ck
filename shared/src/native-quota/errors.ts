import {
  NativeQuotaErrorEnvelopeSchema,
  type NativeQuotaErrorEnvelope,
} from "./contracts";

type StructuredServerError = {
  kind?: unknown;
  details?: unknown;
  cause?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 同时处理 HTTP/RPC 的 ServerError、WebSocket query-result error 与 cause 链。
 * 只读取结构化 kind/details，刻意不读取 message，避免错误文案变更影响业务判断。
 */
export function extractNativeQuotaError(input: unknown): NativeQuotaErrorEnvelope | null {
  let current: unknown = input;
  const visited = new Set<unknown>();

  while (isRecord(current) && !visited.has(current)) {
    visited.add(current);
    const candidate = current as StructuredServerError;
    if (candidate.kind === "Quota") {
      const parsed = NativeQuotaErrorEnvelopeSchema.safeParse(candidate.details);
      return parsed.success ? parsed.data : null;
    }
    current = candidate.cause;
  }

  return null;
}

