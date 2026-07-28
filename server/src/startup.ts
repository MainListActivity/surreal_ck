import { createApp } from "./app";
import { env } from "./env";
import { closeRootConnection, initRootConnection } from "./db/root-connection";
import { ensureSystemSchema } from "./db/system-schema";
import { seedSystemAdmins } from "./db/system-admin-seed";
import { seedQuotaPlans } from "./db/quota-plan-seed";
import { migrateAllWorkspaces } from "./db/migration-runner";
import { startReconcileLoop, type ReconcileLoopHandle } from "./db/reconciler";
import {
  NativeQuotaStartupGateError,
  probeNativeQuotaHttp,
  verifyNativeQuotaRootHandshake,
} from "./db/native-quota/startup-gate";
import {
  startClaimsRiskReminderDispatcher,
  type ClaimsRiskDispatcherHandle,
} from "../ai/office/claims-risk-dispatcher";
import {
  startNativeQuotaRuntime,
  type NativeQuotaRuntimeHandle,
} from "./quota/runtime";

type AppLike = {
  fetch: ReturnType<typeof createApp>["fetch"];
  /** Bun WS handler（createApp 挂载）；透传给 Bun.serve 才能升级 /api/chat/stream。 */
  websocket?: ReturnType<typeof createApp>["websocket"];
};

type ServerHandle = {
  stop(): void;
};

export type StartServerDeps = {
  host?: string;
  port?: number;
  envName?: string;
  probeNativeQuotaHttp?: () => Promise<unknown>;
  initRootConnection?: () => Promise<void>;
  verifyNativeQuotaRootHandshake?: () => Promise<unknown>;
  ensureSystemSchema?: () => Promise<unknown>;
  seedSystemAdmins?: () => Promise<unknown>;
  seedQuotaPlans?: () => Promise<unknown>;
  migrateAllWorkspaces?: () => Promise<unknown>;
  createApp?: () => AppLike;
  serve?: (options: {
    hostname: string;
    port: number;
    fetch: AppLike["fetch"];
    websocket?: AppLike["websocket"];
  }) => ServerHandle;
  startReconcileLoop?: () => ReconcileLoopHandle;
  startQuotaRuntime?: () => NativeQuotaRuntimeHandle;
  startClaimsRiskDispatcher?: () => ClaimsRiskDispatcherHandle;
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
  const probeNativeQuota = deps.probeNativeQuotaHttp
    ?? (() => probeNativeQuotaHttp({ production: envName === "production" }));
  const initRoot = deps.initRootConnection ?? initRootConnection;
  const verifyNativeQuota = deps.verifyNativeQuotaRootHandshake
    ?? verifyNativeQuotaRootHandshake;
  const ensureSchema = deps.ensureSystemSchema ?? ensureSystemSchema;
  const seedAdmins = deps.seedSystemAdmins ?? seedSystemAdmins;
  const seedPlans = deps.seedQuotaPlans ?? seedQuotaPlans;
  const migrateWorkspaces = deps.migrateAllWorkspaces ?? migrateAllWorkspaces;
  const makeApp = deps.createApp ?? createApp;
  const serve =
    deps.serve ??
    ((options: { hostname: string; port: number; fetch: AppLike["fetch"] }) =>
      Bun.serve(options as Parameters<typeof Bun.serve>[0]));
  const startReconcile = deps.startReconcileLoop ?? startReconcileLoop;
  const startQuota = deps.startQuotaRuntime
    ?? (envName === "test"
      ? () => ({ stop() {} })
      : startNativeQuotaRuntime);
  const startClaimsRisk = deps.startClaimsRiskDispatcher
    ?? (envName === "test" ? () => ({ async stop() {} }) : startClaimsRiskReminderDispatcher);
  const closeRoot = deps.closeRootConnection ?? closeRootConnection;

  let rootConnectionAttempted = false;
  try {
    await probeNativeQuota();
    rootConnectionAttempted = true;
    await initRoot();
    await verifyNativeQuota();
  } catch (cause) {
    if (rootConnectionAttempted) {
      try {
        await closeRoot();
      } catch (closeCause) {
        console.error("[server] failed to close root after native quota gate failure", {
          message: closeCause instanceof Error ? closeCause.message : String(closeCause),
        });
      }
    }
    if (cause instanceof NativeQuotaStartupGateError) {
      console.error("[server] native quota startup gate rejected this deployment", {
        stage: cause.stage,
        code: cause.diagnosticCode,
        diagnostics: cause.diagnostics,
      });
    }
    throw cause;
  }
  await ensureSchema();
  await seedAdmins();
  await seedPlans();
  await migrateWorkspaces();

  const app = makeApp();
  const server = serve({
    hostname: host,
    port,
    fetch: app.fetch,
    websocket: app.websocket,
  });

  console.info("[server] listening", { host, port, env: envName });

  // 校对心跳不阻塞 boot：启动失败只告警，server 照常对外服务（下次重启再试）。
  let reconcileLoop: ReconcileLoopHandle | undefined;
  try {
    reconcileLoop = startReconcile();
  } catch (cause) {
    console.error("[server] failed to start reconcile heartbeat; continuing without it", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let claimsRiskDispatcher: ClaimsRiskDispatcherHandle | undefined;
  try {
    claimsRiskDispatcher = startClaimsRisk();
  } catch (cause) {
    console.error("[server] failed to start claims risk dispatcher; continuing without it", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let quotaRuntime: NativeQuotaRuntimeHandle | undefined;
  try {
    quotaRuntime = startQuota();
  } catch (cause) {
    console.error(
      "[server] failed to start native quota runtime; continuing without it",
      {
        message: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }

  return {
    server,
    async shutdown(signal: string): Promise<void> {
      console.info("[server] shutting down", { signal });
      server.stop();
      reconcileLoop?.stop();
      quotaRuntime?.stop();
      await claimsRiskDispatcher?.stop();
      await closeRoot();
    },
  };
}
