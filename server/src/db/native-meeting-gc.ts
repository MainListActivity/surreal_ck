import { env } from "../env";
import { createRootSessionSource } from "./root-connection";

type SweepSession = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string): Promise<unknown>;
};

const SWEEP_INTERVAL_MS = 30_000;
const MAX_BATCHES_PER_WORKSPACE = 8;
const SWEEP_WORKSPACE = `
  RETURN IF (SELECT VALUE version FROM ONLY schema_version:current) >= 64 {
    fn::meeting_gc()
  } ELSE { false };
`;

export async function sweepNativeMeetingWorkspaces(
  session: SweepSession,
  namespace: string,
  onError: (database: string) => void,
  shouldContinue = () => true,
): Promise<void> {
  await session.use({ namespace, database: "_system" });
  const result = await session.query("SELECT VALUE db_name FROM workspace WHERE status IN ['active', 'archived'];");
  const databases = Array.isArray(result) ? result[0] : undefined;
  if (!Array.isArray(databases)) return;
  for (const database of databases) {
    if (!shouldContinue()) return;
    if (typeof database !== "string") continue;
    try {
      await session.use({ namespace, database });
      for (let i = 0; i < MAX_BATCHES_PER_WORKSPACE && shouldContinue(); i += 1) {
        const batch = await session.query(SWEEP_WORKSPACE);
        if (!Array.isArray(batch) || batch[0] !== true) break;
      }
    } catch {
      onError(database);
    }
  }
}

export function startNativeMeetingGc(): { stop(): Promise<void> } {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      const session = await createRootSessionSource().newSession();
      try {
        await sweepNativeMeetingWorkspaces(session, env.SURREAL_NS, (database) => {
          console.warn("[native-meeting-gc] workspace sweep failed; will retry", { database });
        }, () => !stopped);
      } finally {
        await session.closeSession();
      }
    })().catch(() => {
      console.warn("[native-meeting-gc] sweep failed; will retry");
    }).finally(() => { running = undefined; });
  };
  tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
