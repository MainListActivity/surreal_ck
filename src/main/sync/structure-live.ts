import { StringRecordId } from "surrealdb";
import { getSyncRuntimeState, markDirtyStructureShadow } from "./status";
import {
  FIXED_STRUCTURE_SHADOW_TABLES,
  rebuildFixedSharedStructureShadow,
} from "./structure-shadow";
import type {
  FixedStructureShadowTable,
} from "./structure-shadow";
import type { LiveMessage, LiveSource, SyncDb } from "./types";

export type StartFixedSharedLiveSubscriptionsOptions = {
  localDb: SyncDb;
  liveSource: LiveSource;
  tables?: readonly FixedStructureShadowTable[];
};

const LIVE_ORIGIN = "remote:live";

let unsubscribers: Array<() => void> = [];

export async function startFixedSharedLiveSubscriptions(
  options: StartFixedSharedLiveSubscriptionsOptions,
): Promise<void> {
  const tables = options.tables ?? FIXED_STRUCTURE_SHADOW_TABLES;
  const local: Array<() => void> = [];
  try {
    for (const table of tables) {
      const off = await options.liveSource.subscribe(table, async (message) => {
        try {
          await applyLiveMessage(options.localDb, message);
        } catch {
          markDirtyStructureShadow(true);
        }
      });
      local.push(off);
    }
    unsubscribers.push(...local);
  } catch (err) {
    for (const off of local) off();
    markDirtyStructureShadow(true);
    throw err;
  }
}

export async function stopFixedSharedLiveSubscriptions(): Promise<void> {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}

export type RecoverDirtyStructureShadowOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
};

export async function recoverDirtyStructureShadow(
  options: RecoverDirtyStructureShadowOptions,
): Promise<void> {
  if (!getSyncRuntimeState().dirtyStructureShadow) return;
  await rebuildFixedSharedStructureShadow({
    localDb: options.localDb,
    remoteDb: options.remoteDb,
  });
  markDirtyStructureShadow(false);
}

async function applyLiveMessage(localDb: SyncDb, message: LiveMessage): Promise<void> {
  if (message.action === "KILLED") {
    markDirtyStructureShadow(true);
    return;
  }
  const recordId = String(message.recordId);
  if (message.action === "CREATE" || message.action === "UPDATE") {
    const { id: _id, ...content } = message.value;
    await localDb.query("UPSERT $record CONTENT $content", {
      record: new StringRecordId(recordId),
      content: { ...content, _origin_session_id: LIVE_ORIGIN },
    });
    return;
  }
  if (message.action === "DELETE") {
    await localDb.query("DELETE $record", {
      record: new StringRecordId(recordId),
    });
  }
}
