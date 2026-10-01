import type { ProjectionVerification } from "@surreal-ck/shared";
import { getContentProjectionSession, type ContentProjectionClient } from "./reader-session";

type Row = Record<string, unknown>;

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : []);

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (value && typeof value === "object" && "toISOString" in value && typeof (value as Date).toISOString === "function") {
    return (value as Date).toISOString();
  }
  return null;
};

/**
 * LCA13：工作区权益的内容投影核验。复用 reader gate 同款受限投影会话
 * （运营不因此获得更高内容权限），只读门禁所需事实：每个权益集合当前
 * 有多少已发布条目、其来源许可的动作与有效期。集合没有任何已发布条目
 * 或许可动作不含 read/cite 时给出可解释结论，供异常队列与运营页展示。
 */
export async function verifyContentProjection(collections: { key: string; label: string }[], client?: ContentProjectionClient): Promise<ProjectionVerification> {
  const checkedAt = new Date().toISOString();
  const db = client ?? await getContentProjectionSession();
  const verified: ProjectionVerification["collections"] = [];
  let verdict: ProjectionVerification["verdict"] = "ok";
  for (const collection of collections) {
    const result = await db.query(
      `
      LET $binds = (SELECT VALUE item FROM content_collection_binding WHERE collections CONTAINS $key);
      LET $published = (SELECT VALUE id FROM content_item WHERE publication_status = "published" AND id IN $binds);
      LET $sources = (SELECT VALUE source FROM content_item WHERE publication_status = "published" AND id IN $binds);
      LET $lic = (SELECT effective_until, allowed_actions FROM source_license_revision
        WHERE source IN $sources ORDER BY revision DESC LIMIT 1)[0];
      RETURN {
        published: array::len($published),
        license_until: $lic.effective_until,
        license_actions: $lic.allowed_actions ?? []
      };
      `,
      { key: collection.key },
    );
    const row = rowsOf(result)[0] ?? {};
    const published = typeof row.published === "number" ? row.published : 0;
    const licenseActions = Array.isArray(row.license_actions) ? row.license_actions.filter((item): item is string => typeof item === "string") : [];
    verified.push({
      key: collection.key,
      label: collection.label,
      publishedItems: published,
      licenseUntil: iso(row.license_until),
      licenseActions,
    });
    if (published === 0) verdict = "empty_collection";
    else if (!licenseActions.includes("read")) verdict = "empty_collection";
  }
  return { checkedAt, verdict, collections: verified };
}

/** 生产装配：投影会话不可用时返回 unavailable，不抛错（核验失败 ≠ 有故障结论）。 */
export function createProjectionVerifier(): (collections: { key: string; label: string }[]) => Promise<ProjectionVerification | null> {
  return async (collections) => {
    try {
      return await verifyContentProjection(collections);
    } catch {
      return { checkedAt: new Date().toISOString(), verdict: "unavailable", collections: [] };
    }
  };
}
