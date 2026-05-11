import { extractDirtyContent, isRemoteEcho, normalizeChangefeedRows, showChangesSql } from "./changefeed";
import { advanceCursor, getCursor } from "./cursor";
import { recordDeadLetter, reconcileFromRemote } from "./dead-letter";
import { classifySyncError } from "./error-classify";
import { shouldSyncRow } from "./scope";
import type { SyncChange, SyncRunResult, SyncWorkerOptions } from "./types";

const RELATION_TABLES = new Set(["has_workspace_member"]);

export class LocalToRemoteWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SyncWorkerOptions) {}

  start(intervalMs = 500): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.runOnce().catch((err) => {
        console.warn("[sync] local-to-remote worker failed:", err);
      });
      this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<SyncRunResult> {
    const result: SyncRunResult = { pulled: 0, pushed: 0, skipped: 0, failed: 0 };
    if (!this.options.isOnline()) return result;

    for (const table of this.options.tables) {
      const cursor = await getCursor(this.options.localDb, "local_to_remote", table);
      const raw = await this.options.localDb.query(showChangesSql(table), { cursor });
      const changes = normalizeChangefeedRows(table, raw);
      result.pulled += changes.length;

      for (const change of changes) {
        if (isRemoteEcho(change) || !shouldSyncRow(table, change.content)) {
          await advanceCursor(this.options.localDb, "local_to_remote", table, change.versionstamp);
          result.skipped += 1;
          continue;
        }

        try {
          await this.pushChange(change);
          await advanceCursor(this.options.localDb, "local_to_remote", table, change.versionstamp);
          result.pushed += 1;
        } catch (err) {
          if (classifySyncError(err) === "semantic") {
            await recordDeadLetter(this.options.localDb, change, err);
            await reconcileFromRemote(this.options.localDb, this.options.remoteDb, change);
            await advanceCursor(this.options.localDb, "local_to_remote", table, change.versionstamp);
            result.skipped += 1;
            continue;
          }
          result.failed += 1;
          break;
        }
      }
    }

    return result;
  }

  private async pushChange(change: SyncChange): Promise<void> {
    switch (change.op) {
      case "create":
        if (isRelationTable(change.table)) {
          await this.options.remoteDb.query(
            `RELATE $in->${change.table}->$out CONTENT $content`,
            {
              in: change.content.in,
              out: change.content.out,
              content: extractDirtyContent(change),
            },
          );
          break;
        }
        await this.options.remoteDb.query(
          `UPSERT $record CONTENT $content`,
          { record: change.recordId, content: change.content },
        );
        break;
      case "update":
        await this.options.remoteDb.query(
          `UPDATE $record MERGE $content`,
          { record: change.recordId, content: extractDirtyContent(change) },
        );
        break;
      case "delete":
        await this.options.remoteDb.query(
          `DELETE $record`,
          { record: change.recordId },
        );
        break;
    }
  }
}

function isRelationTable(table: string): boolean {
  return RELATION_TABLES.has(table) || table.startsWith("rel_");
}
