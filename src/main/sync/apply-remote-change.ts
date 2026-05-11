import { extractDirtyContent } from "./changefeed";
import type { SyncChange, SyncDb } from "./types";

export type ApplyRemoteChangeOptions = {
  pendingLocalFields?: (change: SyncChange) => Promise<Set<string>>;
  originTag?: string;
};

export async function applyRemoteChange(
  localDb: SyncDb,
  change: SyncChange,
  options: ApplyRemoteChangeOptions = {},
): Promise<void> {
  if (change.op === "delete") {
    await localDb.query(`DELETE $record`, { record: change.recordId });
    return;
  }

  const origin = options.originTag ?? `remote:${change.versionstamp}`;
  const pending = options.pendingLocalFields
    ? await options.pendingLocalFields(change)
    : new Set<string>();
  const content = filterPendingLocalFields(extractDirtyContent(change), pending);
  content._origin_session_id = origin;

  if (change.op === "create") {
    await localDb.query(
      `UPSERT $record CONTENT $content`,
      { record: change.recordId, content },
    );
    return;
  }

  await localDb.query(
    `UPDATE $record MERGE $content`,
    { record: change.recordId, content },
  );
}

function filterPendingLocalFields(
  content: Record<string, unknown>,
  pendingLocalFields: Set<string>,
): Record<string, unknown> {
  if (pendingLocalFields.size === 0) return { ...content };

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (pendingLocalFields.has(key)) continue;
    filtered[key] = value;
  }
  return filtered;
}
