import { StringRecordId, type Surreal } from "surrealdb";
import { createDefaultEmbeddingProvider } from "../resources/embedding-provider";
import { createEmbeddingProfileKey, type EmbeddingProvider } from "../resources/research-save";
import { readPlatformEmbeddingProfile, validEmbedding } from "../research/platform-retrieval";

/** Publisher-only derived index. Never overwrites immutable versions or reader gates. */
export async function indexPublishedVersion(
  publisher: Pick<Surreal, "query">,
  versionId: string,
  provider: EmbeddingProvider | undefined = createDefaultEmbeddingProvider(),
): Promise<"indexed" | "disabled" | "failed"> {
  if (!provider) return "disabled";
  try {
    const profile = await readPlatformEmbeddingProfile(publisher);
    if (!profile) return "disabled";
    const result = await publisher.query(`SELECT id, item, title, body_text, body_sha256 FROM content_version
      WHERE public_id = $versionId AND item.current_version = id AND item.publication_status = 'published'
      AND source.status = 'active' AND 'research' IN source.allowed_actions LIMIT 1;`, { versionId });
    const row = Array.isArray(result) && Array.isArray(result[0]) ? result[0][0] as Record<string, unknown> | undefined : undefined;
    if (!row || typeof row.body_text !== "string" || typeof row.body_sha256 !== "string") return "disabled";
    // A current source license must explicitly allow machine use before text leaves the DB.
    const license = await publisher.query(`SELECT allowed_actions FROM source_license_revision
      WHERE source = $version.source AND effective_from <= time::now()
      AND (effective_until = NONE OR effective_until > time::now()) ORDER BY revision DESC LIMIT 1;`,
    { version: new StringRecordId(String(row.id)) });
    const licenseRows = Array.isArray(license) && Array.isArray(license[0]) ? license[0] as Array<{ allowed_actions?: string[] }> : [];
    if (!licenseRows[0]?.allowed_actions?.some((a) => a === "research" || a === "generate")) return "disabled";
    const vector = await provider.embed({ text: `${String(row.title)}\n${row.body_text}`, profile });
    if (!validEmbedding(vector, profile.dimensions)) return "failed";
    await publisher.query(`INSERT INTO content_search_embedding $entry ON DUPLICATE KEY UPDATE
      vector = $entry.vector, body_sha256 = $entry.body_sha256, indexed_at = time::now();`, {
      entry: {
        item: new StringRecordId(String(row.item)), version: new StringRecordId(String(row.id)),
        profile_key: createEmbeddingProfileKey(profile), release: profile.release, body_sha256: row.body_sha256, vector,
      },
    });
    return "indexed";
  } catch { return "failed"; }
}
