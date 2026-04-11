/**
 * Relationship creator: right-click two rows → "Create Relationship" context menu
 * → select relation type + target → RELATE $source->{edge_type}->{target}
 */

import { toRecordId } from '../lib/surreal/record-id';

export interface RelateParams {
  sourceRecordId: string;
  edgeType: string;
  targetRecordId: string;
  workspaceId: string;
}

export interface RelateResult {
  ok: true;
  edgeId: string;
}

export interface RelateError {
  ok: false;
  message: string;
}

/**
 * Creates a graph edge between two records via SurrealDB RELATE.
 */
export async function createRelationship(
  db: import('surrealdb').Surreal,
  params: RelateParams,
): Promise<RelateResult | RelateError> {
  const { sourceRecordId, edgeType, targetRecordId, workspaceId } = params;

  // Validate edge type key (alphanumeric + underscore only — prevent SurrealQL injection).
  if (!/^[a-z_][a-z0-9_]*$/i.test(edgeType)) {
    return { ok: false, message: `Invalid relationship type: "${edgeType}".` };
  }

  try {
    const [rows] = await db.query<[{ id: string }[]]>(
      `RELATE $source->${edgeType}->$target CONTENT { workspace: $ws } RETURN id`,
      { source: toRecordId(sourceRecordId), target: toRecordId(targetRecordId), ws: toRecordId(workspaceId) },
    );
    const edge = rows?.[0];
    if (!edge?.id) throw new Error('RELATE did not return an edge record.');

    return { ok: true, edgeId: edge.id };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to create relationship.' };
  }
}
