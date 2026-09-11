import {
  CitationLocatorSchema,
  ContentCitationSchema,
  IngestionBatchSchema,
  PLATFORM_CONTENT_LIMITS,
  type ContentCitation,
  type IngestionBatch,
  type PlatformContentErrorCode,
  type PlatformContentLimits,
} from "./contracts";

export type PlatformContentValidationIssue = {
  code: PlatformContentErrorCode | "invalid_request";
  entryKey?: string;
  fieldPath?: string;
  message: string;
  retryable: boolean;
};

export type PlatformContentValidationResult =
  | { ok: true; request: IngestionBatch; requestBytes: number; bodyDigests: Record<string, string> }
  | { ok: false; code: PlatformContentErrorCode | "invalid_request"; issues: PlatformContentValidationIssue[] };

export type PlatformContentValidationOptions = Partial<PlatformContentLimits>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonByteLength(input: unknown): number | null {
  try {
    const json = JSON.stringify(input);
    if (typeof json !== "string") return null;
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return null;
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function utf8Slice(value: string, start: number, end: number): string | null {
  const bytes = new TextEncoder().encode(value);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.byteLength) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end));
  } catch {
    return null;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateCitationLocator(
  bodyText: string,
  citation: Pick<ContentCitation, "quotedText" | "locator">,
): Promise<PlatformContentValidationIssue | null> {
  const digest = await sha256Hex(bodyText);
  const locator = CitationLocatorSchema.parse(citation.locator);
  if (locator.bodyDigest.toLowerCase() !== digest) {
    return {
      code: "locator_mismatch",
      fieldPath: "locator.bodyDigest",
      message: "引文定位绑定的正文摘要与当前正文不一致",
      retryable: false,
    };
  }
  const quoted = utf8Slice(bodyText, locator.start, locator.end);
  if (quoted === null || quoted !== citation.quotedText) {
    return {
      code: "locator_mismatch",
      fieldPath: "locator",
      message: "UTF-8 字节定位无法精确还原 quotedText",
      retryable: false,
    };
  }
  return null;
}

function issueFromZod(issue: { path: PropertyKey[]; message: string }): PlatformContentValidationIssue {
  const path = issue.path.map(String).join(".");
  const actorLike = /(?:^|\.)(?:actor|subject|platformActor)(?:\.|$)/u.test(path);
  return {
    code: actorLike ? "forged_actor" : "invalid_request",
    fieldPath: path || undefined,
    message: actorLike ? "调用方身份由 OAuth 注入，提交载荷不能自报 actor/subject" : issue.message,
    retryable: false,
  };
}

function hasFieldIssue(batch: IngestionBatch, entryIndex: number, fieldPath: string): boolean {
  const entry = batch.items[entryIndex];
  if (entry.operation !== "upsert") return false;
  return entry.payload.document.fieldIssues.some((issue) => issue.path === fieldPath);
}

function requiredUnknownIssues(batch: IngestionBatch, entryIndex: number): PlatformContentValidationIssue[] {
  const entry = batch.items[entryIndex];
  if (entry.operation !== "upsert") return [];
  const payload = entry.payload;
  const paths: Array<[string, unknown]> =
    payload.kind === "legislation"
      ? [
          ["legislation.issuingAuthorities", payload.legislation.issuingAuthorities],
          ["legislation.instrumentType", payload.legislation.instrumentType],
          ["legislation.versionResolution", payload.legislation.versionResolution],
        ]
      : [["judgment.documentType", payload.judgment.documentType]];
  return paths.flatMap(([path, value]) => {
    if (value !== null || hasFieldIssue(batch, entryIndex, path)) return [];
    return [
      {
        code: "required_field_missing" as const,
        entryKey: entry.entryKey,
        fieldPath: path,
        message: "未知或缺失的语义字段必须同时提供 fieldIssues 说明",
        retryable: false,
      },
    ];
  });
}

function duplicateIssues(batch: IngestionBatch): PlatformContentValidationIssue[] {
  const issues: PlatformContentValidationIssue[] = [];
  const entryKeys = new Set<string>();
  const targetKeys = new Map<string, string>();
  for (const entry of batch.items) {
    if (entryKeys.has(entry.entryKey)) {
      issues.push({
        code: "duplicate_entry_key",
        entryKey: entry.entryKey,
        message: "同一批次内 entryKey 必须唯一",
        retryable: false,
      });
    }
    entryKeys.add(entry.entryKey);
    if (entry.operation === "upsert" && !entry.payload.target) continue;
    const target = entry.operation === "upsert" ? entry.payload.target : entry.payload.target;
    if (!target) continue;
    const previous = targetKeys.get(target.itemId);
    if (previous) {
      issues.push({
        code: "duplicate_target",
        entryKey: entry.entryKey,
        fieldPath: "payload.target.itemId",
        message: `同一批次不能隐式覆盖同一内容目标（已由 ${previous} 提交）`,
        retryable: false,
      });
    } else {
      targetKeys.set(target.itemId, entry.entryKey);
    }
  }
  return issues;
}

export async function validatePlatformContentBatch(
  input: unknown,
  options: PlatformContentValidationOptions = {},
): Promise<PlatformContentValidationResult> {
  const limits = { ...PLATFORM_CONTENT_LIMITS, ...options };
  const requestBytes = jsonByteLength(input);
  if (requestBytes === null) {
    return {
      ok: false,
      code: "invalid_request",
      issues: [{ code: "invalid_request", message: "请求必须是可序列化的 JSON 对象", retryable: false }],
    };
  }
  if (requestBytes > limits.maxRequestBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      issues: [
        {
          code: "payload_too_large",
          message: `请求大小 ${requestBytes} 字节超过上限 ${limits.maxRequestBytes} 字节`,
          retryable: false,
        },
      ],
    };
  }
  if (isRecord(input) && ("actor" in input || "subject" in input || "platformActor" in input)) {
    return {
      ok: false,
      code: "forged_actor",
      issues: [
        {
          code: "forged_actor",
          fieldPath: "actor",
          message: "调用方身份由 OAuth 注入，提交载荷不能自报 actor/subject",
          retryable: false,
        },
      ],
    };
  }
  const parsed = IngestionBatchSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issueFromZod);
    const code = issues.some((issue) => issue.code === "forged_actor") ? "forged_actor" : "invalid_request";
    return { ok: false, code, issues };
  }
  const request = parsed.data;
  if (request.items.length > limits.maxBatchItems) {
    return {
      ok: false,
      code: "payload_too_large",
      issues: [
        {
          code: "payload_too_large",
          fieldPath: "items",
          message: `批次包含 ${request.items.length} 项，超过上限 ${limits.maxBatchItems} 项`,
          retryable: false,
        },
      ],
    };
  }

  const issues = [...duplicateIssues(request)];
  const bodyDigests: Record<string, string> = {};
  for (const [entryIndex, entry] of request.items.entries()) {
    issues.push(...requiredUnknownIssues(request, entryIndex));
    if (entry.operation !== "upsert") continue;
    const bodyBytes = utf8ByteLength(entry.payload.document.bodyText);
    if (bodyBytes > limits.maxBodyTextBytes) {
      issues.push({
        code: "payload_too_large",
        entryKey: entry.entryKey,
        fieldPath: "payload.document.bodyText",
        message: `正文大小 ${bodyBytes} 字节超过上限 ${limits.maxBodyTextBytes} 字节`,
        retryable: false,
      });
    }
    for (const [evidenceIndex, evidence] of entry.payload.document.evidence.entries()) {
      const evidenceBytes = utf8ByteLength(evidence.text);
      if (evidenceBytes > limits.maxEvidenceTextBytes) {
        issues.push({
          code: "payload_too_large",
          entryKey: entry.entryKey,
          fieldPath: `payload.document.evidence.${evidenceIndex}.text`,
          message: `来源证据大小 ${evidenceBytes} 字节超过上限 ${limits.maxEvidenceTextBytes} 字节`,
          retryable: false,
        });
      }
    }
    const digest = await sha256Hex(entry.payload.document.bodyText);
    bodyDigests[entry.entryKey] = digest;
    if (entry.payload.document.clientDigest && entry.payload.document.clientDigest.bodySha256.toLowerCase() !== digest) {
      issues.push({
        code: "locator_mismatch",
        entryKey: entry.entryKey,
        fieldPath: "payload.document.clientDigest.bodySha256",
        message: "客户端正文摘要与服务端复算结果不一致",
        retryable: false,
      });
    }
    const citations = entry.payload.kind === "judicial_document" ? entry.payload.judgment.citations : [];
    for (const citation of citations) {
      const locatorIssue = await validateCitationLocator(entry.payload.document.bodyText, citation);
      if (locatorIssue) issues.push({ ...locatorIssue, entryKey: entry.entryKey });
      if (citation.resolution === "verified" && citation.relationKind === "inferred_relation") {
        issues.push({
          code: "invalid_request",
          entryKey: entry.entryKey,
          fieldPath: "payload.judgment.citations.resolution",
          message: "系统推断关系不能直接提交为 verified",
          retryable: false,
        });
      }
      if (citation.treatment && citation.treatment !== "unknown" && !citation.treatmentEvidence) {
        issues.push({
          code: "required_field_missing",
          entryKey: entry.entryKey,
          fieldPath: "payload.judgment.citations.treatmentEvidence",
          message: "非 unknown 的采纳语境必须附带原文证据",
          retryable: false,
        });
      }
    }
  }
  if (issues.length > 0) {
    const code = issues.some((issue) => issue.code === "payload_too_large")
      ? "payload_too_large"
      : issues.some((issue) => issue.code === "locator_mismatch")
        ? "locator_mismatch"
        : issues[0]?.code ?? "invalid_request";
    return { ok: false, code, issues };
  }
  return { ok: true, request, requestBytes, bodyDigests };
}

export function assertPlatformContentBatch(
  input: unknown,
  options: PlatformContentValidationOptions = {},
): Promise<Extract<PlatformContentValidationResult, { ok: true }>> {
  return validatePlatformContentBatch(input, options).then((result) => {
    if (!result.ok) throw new Error(`${result.code}: ${result.issues[0]?.message ?? "invalid platform content batch"}`);
    return result;
  });
}
