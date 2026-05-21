import { markIncompatibleSchema } from "./status";
import { wrapSyncOperationError } from "./operation-error";
import type { SyncDb } from "./types";

export const CLIENT_SCHEMA_VERSION = 1;

export async function checkRemoteSchemaVersion(remoteDb: SyncDb): Promise<boolean> {
  let rows: [{ version?: number }[]];
  try {
    rows = await remoteDb.query<[{ version?: number }[]]>(
      `SELECT version FROM schema_version:current LIMIT 1`,
    );
  } catch (err) {
    throw wrapSyncOperationError(
      `remote schema version check query="SELECT version FROM schema_version:current LIMIT 1"`,
      err,
    );
  }
  const version = rows[0]?.[0]?.version;
  const compatible = version === CLIENT_SCHEMA_VERSION;
  markIncompatibleSchema(!compatible);
  return compatible;
}
