import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { env } from "../env";

type Row = Record<string, unknown>;
type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

const rowsOf = (value: unknown): Row[] => Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : [];
const first = (value: unknown): Row | null => rowsOf(value)[0] ?? null;

/** 记录链接在 SDK 里可能是字符串或 RecordId 对象，统一转成 "table:id"。 */
function linkId(value: unknown): string | null {
  if (typeof value === "string") return value.includes(":") ? value : null;
  if (value && typeof value === "object" && "toString" in value) {
    const text = String((value as { toString: () => unknown }).toString());
    return text.includes(":") ? text : null;
  }
  return null;
}

function parseRevisionId(raw: string): StringRecordId {
  const trimmed = raw.trim();
  const full = trimmed.startsWith("product_plan_revision:") ? trimmed : `product_plan_revision:${trimmed}`;
  return new StringRecordId(full);
}

async function linkedRow(db: Queryable, link: unknown): Promise<Row | null> {
  const id = linkId(link);
  return id ? first(await db.query(`SELECT * FROM $id;`, { id: new StringRecordId(id) })) : null;
}

/**
 * 运营诊断（LCA05）：把产品修订与其模板行的原始数据、相关表结构读出来，
 * 用于定位「快照 ai_actions 恒空」这类数据面问题。全部只读，root 会话。
 */
export async function inspectProductRevisionRaw(id: string): Promise<unknown> {
  const db = await getRootDatabaseSession("_system", env.SURREAL_NS);
  const revision = first(await db.query(`SELECT * FROM $id;`, { id: parseRevisionId(id) }));
  if (!revision) return { revision: null };
  const [content, ai, feature, resource] = await Promise.all([
    linkedRow(db, revision.content_template),
    linkedRow(db, revision.ai_template),
    linkedRow(db, revision.feature_template),
    linkedRow(db, revision.resource_template),
  ]);
  // 复刻 store.productRevision 对 ai 模板的精确读法，便于对照「SELECT * 」与投影读法差异。
  const aiLinkId = linkId(revision.ai_template);
  const aiActionsProjection = aiLinkId
    ? first(await db.query(`SELECT actions FROM $id;`, { id: new StringRecordId(aiLinkId) }))
    : null;
  const [aiTemplateSchema, snapshotSchema] = await Promise.all([
    db.query(`INFO FOR TABLE ai_template_revision;`),
    db.query(`INFO FOR TABLE workspace_product_entitlement;`),
  ]);
  return {
    revision,
    templates: { content, ai, feature, resource },
    aiActionsProjection,
    schema: {
      ai_template_revision: aiTemplateSchema,
      workspace_product_entitlement: snapshotSchema,
    },
  };
}
