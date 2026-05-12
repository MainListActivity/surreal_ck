import { applyRemoteChange } from "./apply-remote-change";
import { extractDirtyContent, isRemoteEcho, normalizeChangefeedRows, showChangesSql } from "./changefeed";
import { advanceCursor, getCursor } from "./cursor";
import type { SyncChange, SyncRunResult, SyncWorkerOptions } from "./types";

export class RemoteToLocalWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SyncWorkerOptions) {}

  start(intervalMs = 2000): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.runOnce().catch((err) => {
        console.warn("[sync] remote-to-local worker failed:", err);
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
      const cursor = await getCursor(this.options.localDb, "remote_to_local", table);
      const raw = await this.options.remoteDb.query(showChangesSql(table), { cursor });
      const changes = normalizeChangefeedRows(table, raw);
      result.pulled += changes.length;

      for (const change of changes) {
        try {
          const pendingFields = await this.pendingLocalFields(change);
          await applyRemoteChange(this.options.localDb, change, {
            pendingLocalFields: async () => pendingFields,
          });
          await advanceCursor(this.options.localDb, "remote_to_local", table, change.versionstamp);
        } catch {
          result.failed += 1;
          break;
        }
      }
    }

    return result;
  }

  private async pendingLocalFields(change: SyncChange): Promise<Set<string>> {
    if (change.op !== "update") return new Set();

    const cursor = await getCursor(this.options.localDb, "local_to_remote", change.table);
    const raw = await this.options.localDb.query(showChangesSql(change.table), { cursor });
    const pendingChanges = normalizeChangefeedRows(change.table, raw);
    const fields = new Set<string>();

    for (const pending of pendingChanges) {
      if (pending.recordId !== change.recordId || isRemoteEcho(pending)) continue;
      for (const field of Object.keys(extractDirtyContent(pending))) {
        fields.add(field);
      }
    }

    return fields;
  }
}
