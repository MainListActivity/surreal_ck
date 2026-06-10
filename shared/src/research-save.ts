/**
 * RR-012 资源保存确认动作（POST /api/resources/research/save）的共享契约。
 *
 * 校验在前后端共用：panel 在发送前预检，后端在 SSE 动作里复检。
 * V1 资源类型注册表内置 generic_note / web_article，legal_case / legal_article 预留。
 * sourceUrl（草稿与证据）只接受 http / https。
 */
import { z } from "zod";

export const ACTIVE_RESOURCE_TYPES = ["generic_note", "web_article"] as const;
export const RESERVED_RESOURCE_TYPES = ["legal_case", "legal_article"] as const;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const HttpUrlSchema = z
  .string()
  .trim()
  .refine(isHttpUrl, { message: "只允许 http / https URL" });

const ResearchEvidenceSchema = z.object({
  text: z.string().trim().min(1, "证据文本不能为空"),
  sourceUrl: HttpUrlSchema.optional(),
  sourceTitle: z.string().trim().min(1).optional(),
  capturedAt: z.iso.datetime({ message: "capturedAt 必须是 ISO datetime" }),
  order: z.number().int().nonnegative(),
});

const StructuredPayloadByType: Record<string, z.ZodType<Record<string, unknown>>> = {
  generic_note: z.strictObject({}),
  web_article: z.strictObject({
    author: z.string().trim().min(1).optional(),
    publishedAt: z.iso.datetime().optional(),
    siteName: z.string().trim().min(1).optional(),
  }),
};

const ResearchResourceDraftSchema = z
  .object({
    resourceType: z.string().trim().default("generic_note"),
    title: z.string().trim().min(1, "标题不能为空"),
    summary: z.string().trim().min(1, "摘要不能为空"),
    sourceUrl: HttpUrlSchema.optional(),
    sourceTitle: z.string().trim().min(1).optional(),
    evidence: z.array(ResearchEvidenceSchema).min(1, "至少需要一段证据"),
    tags: z
      .array(z.string())
      .default([])
      .transform((tags) => [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]),
    structuredPayload: z.record(z.string(), z.unknown()).default({}),
    quality: z.enum(["user-confirmed", "ai-draft", "imported", "deprecated"]).default("user-confirmed"),
    confidence: z.number().optional(),
    sourceTrust: z.string().trim().min(1).optional(),
  })
  .superRefine((draft, ctx) => {
    const payloadSchema = StructuredPayloadByType[draft.resourceType];
    if (!payloadSchema) {
      const reserved = (RESERVED_RESOURCE_TYPES as readonly string[]).includes(draft.resourceType);
      ctx.addIssue({
        code: "custom",
        path: ["resourceType"],
        message: reserved ? `资源类型 ${draft.resourceType} 已预留但尚未启用` : `未知资源类型: ${draft.resourceType}`,
      });
      return;
    }
    const payload = payloadSchema.safeParse(draft.structuredPayload);
    if (!payload.success) {
      ctx.addIssue({ code: "custom", path: ["structuredPayload"], message: "资源结构化 payload 不符合类型约束" });
    }
    if (draft.resourceType === "web_article") {
      if (!draft.sourceUrl) {
        ctx.addIssue({ code: "custom", path: ["sourceUrl"], message: "web_article 必须包含有效 sourceUrl" });
      }
      if (!draft.sourceTitle) {
        ctx.addIssue({ code: "custom", path: ["sourceTitle"], message: "web_article 必须包含 sourceTitle" });
      }
    }
  });

export const ResearchSaveRequestSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId 不能为空"),
  draft: ResearchResourceDraftSchema,
});

export type ResearchResourceDraft = z.infer<typeof ResearchResourceDraftSchema>;
export type ResearchSaveRequest = z.infer<typeof ResearchSaveRequestSchema>;

export type ResearchSaveValidation =
  | { ok: true; request: ResearchSaveRequest }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export function validateResearchSaveRequest(input: unknown): ResearchSaveValidation {
  const parsed = ResearchSaveRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, request: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** SSE 保存动作的进度事件；失败时 error 标记发生阶段，前端据此保留草稿并允许重试。 */
export type ResearchSaveStage = "validating" | "embedding" | "persisting" | "session-updated";

export type ResearchSaveEvent =
  | { kind: "validating" }
  | { kind: "embedding"; status: "generating" | "disabled" }
  | { kind: "persisting" }
  | { kind: "session-updated"; sessionId: string; resourceId: string }
  | { kind: "done"; resourceId: string; embeddingStatus: "indexed" | "disabled" }
  | { kind: "error"; stage: ResearchSaveStage; message: string };

const ResearchSaveEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("validating") }),
  z.object({ kind: z.literal("embedding"), status: z.enum(["generating", "disabled"]) }),
  z.object({ kind: z.literal("persisting") }),
  z.object({ kind: z.literal("session-updated"), sessionId: z.string(), resourceId: z.string() }),
  z.object({ kind: z.literal("done"), resourceId: z.string(), embeddingStatus: z.enum(["indexed", "disabled"]) }),
  z.object({
    kind: z.literal("error"),
    stage: z.enum(["validating", "embedding", "persisting", "session-updated"]),
    message: z.string(),
  }),
]);

/** 解析 SSE data 行里的事件 JSON；不合法返回 null（前端跳过未知事件保持向前兼容）。 */
export function parseResearchSaveEvent(input: unknown): ResearchSaveEvent | null {
  const parsed = ResearchSaveEventSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
