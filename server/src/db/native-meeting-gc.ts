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

export function createNativeMeetingBatchRunner(
  surrealUrl: string,
  getAccessToken: () => string | undefined,
  fetcher = fetch,
) {
  const url = new URL(surrealUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported SurrealDB URL protocol");
  }
  url.pathname = url.pathname.replace(/\/rpc\/?$/, "/").replace(/\/?$/, "/sql");
  url.search = "";
  url.hash = "";

  return async (namespace: string, database: string): Promise<boolean> => {
    const token = getAccessToken();
    if (!token) throw new Error("Missing root session access token");

    // RPC 和 SurrealQL 的 USE 都可能重新建出已删除的库；HTTP scope 只为本次查询选库。
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(SWEEP_INTERVAL_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "surreal-ns": namespace,
        "surreal-db": database,
        "content-type": "text/plain",
        accept: "application/json",
      },
      body: SWEEP_WORKSPACE,
    });
    if (!response.ok) throw new Error(`Meeting sweep HTTP status ${response.status}`);
    const rows: unknown = await response.json();
    const statement = Array.isArray(rows) ? rows[0] : undefined;
    if (statement?.status !== "OK" || typeof statement.result !== "boolean") {
      throw new Error("Meeting sweep statement failed");
    }
    return statement.result;
  };
}

export async function sweepNativeMeetingWorkspaces(
  session: SweepSession,
  namespace: string,
  runBatch: ReturnType<typeof createNativeMeetingBatchRunner>,
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
      for (let i = 0; i < MAX_BATCHES_PER_WORKSPACE && shouldContinue(); i += 1) {
        if (!await runBatch(namespace, database)) break;
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
        const runBatch = createNativeMeetingBatchRunner(env.SURREAL_URL, () => session.accessToken);
        await sweepNativeMeetingWorkspaces(session, env.SURREAL_NS, runBatch, (database) => {
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
