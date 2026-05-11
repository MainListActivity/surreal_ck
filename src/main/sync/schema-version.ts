import { markIncompatibleSchema } from "./status";
import type { SyncDb } from "./types";

export const CLIENT_SCHEMA_VERSION = 1;

export async function checkRemoteSchemaVersion(remoteDb: SyncDb): Promise<boolean> {
  const rows = await remoteDb.query<[{ version?: number }[]]>(
    `SELECT version FROM schema_version:current LIMIT 1`,
  );
  const version = rows[0]?.[0]?.version;
  const compatible = version === CLIENT_SCHEMA_VERSION;
  markIncompatibleSchema(!compatible);
  return compatible;
}
