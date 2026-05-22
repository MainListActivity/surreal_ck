import { createApp } from "./app";
import { env } from "./env";
import { closeRootConnection, initRootConnection } from "./db/root-connection";
import { ensureSystemSchema } from "./db/system-schema";
import { migrateAllWorkspaces } from "./db/migration-runner";

type AppLike = {
  fetch: ReturnType<typeof createApp>["fetch"];
};

type ServerHandle = {
  stop(): void;
};

export type StartServerDeps = {
  host?: string;
  port?: number;
  envName?: string;
  initRootConnection?: () => Promise<void>;
  ensureSystemSchema?: () => Promise<unknown>;
  migrateAllWorkspaces?: () => Promise<unknown>;
  createApp?: () => AppLike;
  serve?: (options: { hostname: string; port: number; fetch: AppLike["fetch"] }) => ServerHandle;
  closeRootConnection?: () => Promise<void>;
};

export type RunningServer = {
  server: ServerHandle;
  shutdown(signal: string): Promise<void>;
};

export async function startServer(deps: StartServerDeps = {}): Promise<RunningServer> {
  const host = deps.host ?? env.HOST;
  const port = deps.port ?? env.PORT;
  const envName = deps.envName ?? env.NODE_ENV;
  const initRoot = deps.initRootConnection ?? initRootConnection;
  const ensureSchema = deps.ensureSystemSchema ?? ensureSystemSchema;
  const migrateWorkspaces = deps.migrateAllWorkspaces ?? migrateAllWorkspaces;
  const makeApp = deps.createApp ?? createApp;
  const serve =
    deps.serve ??
    ((options: { hostname: string; port: number; fetch: AppLike["fetch"] }) =>
      Bun.serve(options as Parameters<typeof Bun.serve>[0]));
  const closeRoot = deps.closeRootConnection ?? closeRootConnection;

  await initRoot();
  await ensureSchema();
  await migrateWorkspaces();

  const app = makeApp();
  const server = serve({
    hostname: host,
    port,
    fetch: app.fetch,
  });

  console.info("[server] listening", { host, port, env: envName });

  return {
    server,
    async shutdown(signal: string): Promise<void> {
      console.info("[server] shutting down", { signal });
      server.stop();
      await closeRoot();
    },
  };
}
