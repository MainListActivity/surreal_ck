/**
 * RR-012 资源保存确认动作的核心服务：一次用户确认 = 一个事件流
 * validating → embedding（或 disabled）→ persisting → session-updated → done。
 *
 * 所有 SurrealDB 写入都走调用者 workspace session（资源归因 DEFAULT $auth），
 * 不使用 root / service / employee 身份。失败只产出 error 事件——V1 没有
 * embedding 重试队列 / enqueue endpoint，前端保留草稿让用户再次点击保存。
 */
import { randomUUID, createHash } from "node:crypto";
import { RecordId, StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import {
  validateResearchSaveRequest,
  type ResearchResourceDraft,
  type ResearchSaveEvent,
} from "@surreal-ck/shared";

export type EmbeddingProfile = {
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  base_url?: string;
  api_format?: string;
};

export type EmbeddingProvider = {
  embed(input: { text: string; profile: EmbeddingProfile }): Promise<number[]>;
};

export type ResearchSaveDeps = {
  /** 调用者 workspace session（OIDC token authenticate 出来的 admin / participant access）。 */
  session: Surreal;
  /** 服务端持 key 的 embedding 生成器；未配置而 workspace 有 profile 时保存失败。 */
  embeddingProvider?: EmbeddingProvider;
};

const SESSION_NOT_OPEN = "research-session-not-open";

/** 与 legacy 检索实现一致的 embedding 文本拼装：标题 / 摘要 / 来源标题 / tags / 证据全文。 */
export function buildResourceEmbeddingText(draft: ResearchResourceDraft): string {
  return [
    draft.title,
    draft.summary,
    draft.sourceTitle,
    draft.tags.join("\n"),
    ...draft.evidence.map((item) => item.text),
  ]
    .filter(Boolean)
    .join("\n");
}

/** profile 维度变化即 key 变化，保证不同 profile 的向量不会混入同一相似度检索。 */
export function createEmbeddingProfileKey(profile: EmbeddingProfile): string {
  const provider = encodeURIComponent(profile.provider.trim().toLowerCase());
  const model = encodeURIComponent(profile.model.trim());
  const version = encodeURIComponent(profile.version.trim());
  return `provider=${provider}|model=${model}|dimensions=${profile.dimensions}|version=${version}`;
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

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function duplicateHashes(draft: ResearchResourceDraft): {
  content_hash: string;
  evidence_hash: string;
  source_hash: string;
} {
  return {
    content_hash: stableHash({
      resourceType: draft.resourceType,
      title: draft.title,
      summary: draft.summary,
      tags: draft.tags,
      structuredPayload: draft.structuredPayload,
    }),
    evidence_hash: stableHash(
      draft.evidence.map((item) => ({
        text: item.text,
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
      })),
    ),
    source_hash: stableHash({ sourceUrl: draft.sourceUrl, sourceTitle: draft.sourceTitle }),
  };
}

async function readEmbeddingProfile(session: Surreal): Promise<EmbeddingProfile | null> {
  const results = await session.query<[EmbeddingProfile | null]>(
    "SELECT * FROM ONLY workspace_embedding_profile:default;",
  );
  const profile = results[0];
  return profile ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一次保存动作，把进度作为事件流吐出。原子边界：资源主数据、向量记录与
 * research_session 更新在同一数据库事务内提交——persisting 失败不会留下半个资源。
 */
export async function* runResearchSave(
  deps: ResearchSaveDeps,
  input: unknown,
): AsyncGenerator<ResearchSaveEvent> {
  yield { kind: "validating" };
  const validation = validateResearchSaveRequest(input);
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    yield { kind: "error", stage: "validating", message: detail || "资源草稿校验失败" };
    return;
  }
  const { sessionId, draft } = validation.request;

  // ── embedding 阶段：有 profile 才生成；没有 profile = 语义索引未配置，保存仍可继续 ──
  let profile: EmbeddingProfile | null;
  try {
    profile = await readEmbeddingProfile(deps.session);
  } catch (error) {
    yield { kind: "error", stage: "embedding", message: errorMessage(error) };
    return;
  }

  let vector: number[] | null = null;
  if (profile) {
    yield { kind: "embedding", status: "generating" };
    if (!deps.embeddingProvider) {
      yield { kind: "error", stage: "embedding", message: "embedding provider 未在服务端配置" };
      return;
    }
    try {
      vector = await deps.embeddingProvider.embed({ text: buildResourceEmbeddingText(draft), profile });
    } catch (error) {
      yield { kind: "error", stage: "embedding", message: errorMessage(error) };
      return;
    }
    if (vector.length !== profile.dimensions) {
      yield {
        kind: "error",
        stage: "embedding",
        message: `embedding 维度 ${vector.length} 与 profile 配置 ${profile.dimensions} 不一致`,
      };
      return;
    }
  } else {
    yield { kind: "embedding", status: "disabled" };
  }

  // ── persisting：单事务写 resource_item（+ resource_embedding）+ research_session ──
  yield { kind: "persisting" };
  const resourceId = new RecordId("resource_item", randomUUID());
  const embeddingText = buildResourceEmbeddingText(draft);

  const statements = [
    "BEGIN TRANSACTION;",
    // session 必须存在且 open；否则整个事务回滚，不留半个资源。
    "LET $updated = UPDATE ONLY $session_id SET created_resources += $resource_id WHERE status = 'open';",
    `IF $updated = NONE { THROW "${SESSION_NOT_OPEN}" };`,
    "CREATE ONLY $resource_id CONTENT $resource_content;",
  ];
  const binds: Record<string, unknown> = {
    session_id: new StringRecordId(sessionId),
    resource_id: resourceId,
    resource_content: {
      resource_type: draft.resourceType,
      title: draft.title,
      summary: draft.summary,
      source_url: draft.sourceUrl,
      source_title: draft.sourceTitle,
      evidence: draft.evidence,
      tags: draft.tags,
      structured_payload: draft.structuredPayload,
      quality: draft.quality,
      confidence: draft.confidence,
      source_trust: draft.sourceTrust,
      ...duplicateHashes(draft),
    },
  };

  if (profile && vector) {
    statements.push(
      "INSERT INTO resource_embedding $embedding_content ON DUPLICATE KEY UPDATE " +
        "vector = $embedding_content.vector, status = 'indexed', " +
        "embedding_text_hash = $embedding_content.embedding_text_hash, indexed_at = time::now();",
    );
    binds.embedding_content = {
      resource: resourceId,
      profile_key: createEmbeddingProfileKey(profile),
      provider: profile.provider,
      model: profile.model,
      dimensions: profile.dimensions,
      profile_version: profile.version,
      embedding_text_hash: stableHash(embeddingText),
      vector,
      status: "indexed",
      indexed_at: new Date(),
    };
  }
  statements.push("COMMIT TRANSACTION;");

  try {
    await deps.session.query(statements.join("\n"), binds);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes(SESSION_NOT_OPEN)) {
      yield { kind: "error", stage: "session-updated", message: "research session 不存在或已结束" };
    } else {
      yield { kind: "error", stage: "persisting", message };
    }
    return;
  }

  yield { kind: "session-updated", sessionId, resourceId: resourceId.toString() };
  yield {
    kind: "done",
    resourceId: resourceId.toString(),
    embeddingStatus: profile ? "indexed" : "disabled",
  };
}
