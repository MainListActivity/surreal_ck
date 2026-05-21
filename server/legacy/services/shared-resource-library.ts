import { createHash } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "./errors";
import type {
  ResourceDuplicateHashes,
  ResourceEvidence,
  SaveResourceRequest,
} from "./resources";

const EvidenceSchema = z.object({
  text: z.string().trim().min(1),
  sourceUrl: z.string().trim().url().optional(),
  sourceTitle: z.string().trim().min(1).optional(),
  capturedAt: z.string().datetime(),
  order: z.number().int().nonnegative(),
});

const ResourceQualitySchema = z.enum(["user-confirmed", "ai-draft", "imported", "deprecated"]);

const ActiveResourceTypeRegistry = {
  generic_note: z.object({}).strict(),
  web_article: z.object({
    author: z.string().trim().min(1).optional(),
    publishedAt: z.string().datetime().optional(),
    siteName: z.string().trim().min(1).optional(),
  }).strict(),
} satisfies Record<string, z.ZodType<Record<string, unknown>>>;

const RESERVED_RESOURCE_TYPES = ["legal_case", "legal_article"] as const;

export type ResourceTypeDefinition = {
  type: string;
  status: "active" | "reserved";
};

export type NormalizedSharedResourceRequest = Required<
  Pick<SaveResourceRequest, "workspaceId" | "resourceType" | "title" | "summary" | "evidence" | "tags" | "structuredPayload" | "quality">
> & Omit<SaveResourceRequest, "workspaceId" | "resourceType" | "title" | "summary" | "evidence" | "tags" | "structuredPayload" | "quality">;

export type PreparedSharedResourceDraft = {
  normalized: NormalizedSharedResourceRequest;
  duplicateHashes: ResourceDuplicateHashes;
};

export function listResourceTypeDefinitions(): ResourceTypeDefinition[] {
  return [
    ...Object.keys(ActiveResourceTypeRegistry).map((type) => ({ type, status: "active" as const })),
    ...RESERVED_RESOURCE_TYPES.map((type) => ({ type, status: "reserved" as const })),
  ];
}

export function prepareSharedResourceDraft(req: SaveResourceRequest): PreparedSharedResourceDraft {
  const normalized = normalizeSharedResourceRequest(req);
  return {
    normalized,
    duplicateHashes: createDuplicateHashes(normalized),
  };
}

export function normalizeSharedResourceRequest(req: SaveResourceRequest): NormalizedSharedResourceRequest {
  const resourceType = req.resourceType.trim();
  const structuredPayload = validateStructuredPayload(resourceType, req.structuredPayload ?? {});
  const evidenceParsed = z.array(EvidenceSchema).safeParse(req.evidence);
  if (!evidenceParsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "证据段不符合资源保存要求");
  }
  const qualityParsed = ResourceQualitySchema.safeParse(req.quality);
  if (!qualityParsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "资源质量不符合约束");
  }

  const normalized = {
    ...req,
    workspaceId: req.workspaceId,
    resourceType,
    title: requiredTrimmed(req.title, "标题不能为空"),
    summary: requiredTrimmed(req.summary, "摘要不能为空"),
    sourceUrl: optionalTrimmed(req.sourceUrl),
    sourceTitle: optionalTrimmed(req.sourceTitle),
    evidence: evidenceParsed.data,
    tags: [...new Set((req.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    structuredPayload,
    quality: qualityParsed.data,
  };
  validateResourceTypeRequiredFields(normalized);
  return normalized;
}

export function validateResourceType(resourceType: string): z.ZodType<Record<string, unknown>> {
  const schema = ActiveResourceTypeRegistry[resourceType as keyof typeof ActiveResourceTypeRegistry];
  if (!schema) {
    if ((RESERVED_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new ServiceError("VALIDATION_ERROR", `资源类型 ${resourceType} 已预留但尚未启用`);
    }
    throw new ServiceError("VALIDATION_ERROR", `未知资源类型: ${resourceType}`);
  }
  return schema;
}

function validateStructuredPayload(resourceType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const schema = validateResourceType(resourceType);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION_ERROR", "资源结构化 payload 不符合类型约束");
  }
  return parsed.data;
}

function validateResourceTypeRequiredFields(input: Pick<
  SaveResourceRequest,
  "resourceType" | "sourceUrl" | "sourceTitle" | "evidence"
>): void {
  if (input.resourceType !== "web_article") return;
  if (!input.sourceUrl || !isHttpUrl(input.sourceUrl)) {
    throw new ServiceError("VALIDATION_ERROR", "web_article 必须包含有效 sourceUrl");
  }
  if (!input.sourceTitle?.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "web_article 必须包含 sourceTitle");
  }
  if (!input.evidence.length) {
    throw new ServiceError("VALIDATION_ERROR", "web_article 至少需要一段证据");
  }
}

function createDuplicateHashes(input: {
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
}): ResourceDuplicateHashes {
  return {
    content: stableHash({
      resourceType: input.resourceType,
      title: input.title,
      summary: input.summary,
      tags: input.tags,
      structuredPayload: input.structuredPayload,
    }),
    evidence: stableHash(input.evidence.map((item) => ({
      text: item.text,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
    }))),
    source: stableHash({
      sourceUrl: input.sourceUrl,
      sourceTitle: input.sourceTitle,
    }),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requiredTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ServiceError("VALIDATION_ERROR", message);
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
