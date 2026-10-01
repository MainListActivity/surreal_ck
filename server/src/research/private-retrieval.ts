import type { Surreal } from "surrealdb";
import { validEmbedding } from "./platform-retrieval";
import { createEmbeddingProfileKey, type EmbeddingProfile, type EmbeddingProvider } from "../resources/research-save";

/** The workspace is selected by the caller session, never by a model-provided ID.
 * Freshness guard: only vectors whose stored hash still matches the current
 * text participate (write side hashes the same raw UTF-8 assembly).
 * array::join(arr, sep) — in this fork string::join takes (sep, ...strings). */
export const PRIVATE_VECTOR_QUERY = `SELECT resource, (1 - vector::similarity::cosine(vector, $vector)) AS distance
 FROM resource_embedding WHERE profile_key = $profileKey AND status = 'indexed'
 AND array::len(vector) = $dimensions AND resource.id != NONE
 AND embedding_text_hash = crypto::sha256(array::join(array::filter(array::concat(
   [resource.title, resource.summary, resource.source_title, array::join(resource.tags, '\\n')],
   resource.evidence.map(|$e| $e.text)
 ), |$t| $t != NONE AND $t != ''), '\\n'))
 ORDER BY distance ASC, resource ASC LIMIT 40 TIMEOUT 2s;`;

export async function retrievePrivateVectorScores(input: {
  session: Pick<Surreal, "query">; profile: EmbeddingProfile; query: string; provider: EmbeddingProvider;
}): Promise<Map<string, number>> {
  const vector = await input.provider.embed({ text: input.query, profile: input.profile });
  if (!validEmbedding(vector, input.profile.dimensions)) throw new Error("invalid-query-vector");
  const result = await input.session.query(PRIVATE_VECTOR_QUERY, {
    profileKey: createEmbeddingProfileKey(input.profile), dimensions: input.profile.dimensions, vector,
  });
  const records = Array.isArray(result) && Array.isArray(result[0]) ? result[0] as Array<{ resource: unknown; distance: number }> : [];
  // Similarities are used only within this one active workspace profile. Platform
  // adapter fusion uses ordinal ranks separately, never these raw distances.
  return new Map(records.filter((r) => typeof r.distance === "number" && Number.isFinite(r.distance))
    .map((r) => [String(r.resource), Math.max(0, 1 - r.distance)]));
}
