import { applyRemoteChange } from "./apply-remote-change";
import { normalizeChangefeedRows, showChangesSql } from "./changefeed";
import { advanceCursor, getCursor } from "./cursor";
import type { SyncRunResult, SyncWorkerOptions } from "./types";

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
          await applyRemoteChange(this.options.localDb, change);
          await advanceCursor(this.options.localDb, "remote_to_local", table, change.versionstamp);
        } catch {
          result.failed += 1;
          break;
        }
      }
    }

    return result;
  }
}
