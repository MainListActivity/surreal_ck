import { createApp } from "./app";
import { env } from "./env";
import { closeRootConnection, getRootDatabaseSession, initRootConnection, removeRootWorkspaceDatabase, withRootDatabaseSessions } from "./db/root-connection";
import { closeHealthProbe, initHealthProbe } from "./db/health-probe";
import { ensureSystemSchema } from "./db/system-schema";
import { ensurePlatformContentSchema } from "./content/schema";
import { assertLegacyContentMigrated } from "./content/migrate-legacy";
import { reconcileCitationResolutions } from "./content/citation-resolution";
import { initContentPublisherSession, closeContentPublisherSession, contentPublisherQuery } from "./content/publisher-session";
import { initContentProjectionSession, closeContentProjectionSession } from "./content/reader-session";
import { defineContentReaderAccess } from "./content/reader-access";
import { seedSystemAdmins } from "./db/system-admin-seed";
import { seedPlatformOperators } from "./db/platform-operator-seed";
import { seedQuotaPlans } from "./db/quota-plan-seed";
import { migrateAllWorkspaces } from "./db/migration-runner";
import { retryAtomicConflict } from "./db/atomic-conflict-retry";
import { startReconcileLoop, type ReconcileLoopHandle } from "./db/reconciler";
import { startNativeMeetingGc } from "./db/native-meeting-gc";
import { runFailedTestKitInvitationReaper, runTestSubjectReaper, type TestSubjectReaperDeps } from "./test-subjects/reaper";
import { createIdpAdminClientFromEnv, createIdpProvisionCancellation } from "./invitations/idp-admin-client";
import { createPlatformSecretStore } from "./platform/secret-store";
import { startFunnelLoop, type FunnelLoopHandle } from "./funnel/loop";
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
  startEmployeeSupervision,
  stopEmployeeRuntime,
  stopEmployeeTriggerRuntime,
} from "../ai/office/employee-service";
import {
  startOfficeReconciler,
  type OfficeReconcilerHandle,
} from "../ai/office/office-trigger-adapter";
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
  stop(closeActiveConnections?: boolean): void | Promise<void>;
};

export type StartServerDeps = {
  host?: string;
  port?: number;
  envName?: string;
  /** off：只对外服务 HTTP，不启动任何后台循环（发布桥接进程用，见 production-release runbook）。 */
  backgroundWorkers?: boolean;
  /** 关停时等待在途请求结束的上限；超时后强制断开，再关闭数据库连接。 */
  shutdownDrainMs?: number;
  probeNativeQuotaHttp?: () => Promise<unknown>;
  initRootConnection?: () => Promise<void>;
  /** /health 专用探测连接；test 环境默认不建立（探针断开即 /health 如实 down）。 */
  initHealthProbe?: () => Promise<void>;
  verifyNativeQuotaRootHandshake?: () => Promise<unknown>;
  ensureSystemSchema?: () => Promise<unknown>;
  ensurePlatformContentSchema?: () => Promise<unknown>;
  assertLegacyContentMigrated?: () => Promise<unknown>;
  verifyLegacyContentCopy?: () => Promise<unknown>;
  initContentPublisherSession?: () => Promise<unknown>;
  initContentProjectionSession?: () => Promise<unknown>;
  defineContentReaderAccess?: () => Promise<unknown>;
  reconcileCitationResolutions?: () => Promise<unknown>;
  seedSystemAdmins?: () => Promise<unknown>;
  seedPlatformOperators?: () => Promise<unknown>;
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
  /** 漏斗埋点聚合心跳（任务 d70c3748）；test 环境默认不启动。 */
  startFunnelLoop?: () => FunnelLoopHandle;
  startQuotaRuntime?: () => NativeQuotaRuntimeHandle;
  startClaimsRiskDispatcher?: () => ClaimsRiskDispatcherHandle;
  /** 办公室领域 reconciliation（VO02）；test 环境默认不启动。 */
  startOfficeReconciler?: () => OfficeReconcilerHandle;
  startTestSubjectReaper?: () => { stop(): void };
  closeRootConnection?: () => Promise<void>;
  closeHealthProbe?: () => Promise<void>;
  closeContentPublisherSession?: () => Promise<void>;
  closeContentProjectionSession?: () => Promise<void>;
};

export type RunningServer = {
  server: ServerHandle;
  shutdown(signal: string): Promise<void>;
};

export async function startServer(deps: StartServerDeps = {}): Promise<RunningServer> {
  const host = deps.host ?? env.HOST;
  const port = deps.port ?? env.PORT;
  const envName = deps.envName ?? env.NODE_ENV;
  const backgroundWorkers = deps.backgroundWorkers ?? env.SERVER_BACKGROUND_WORKERS === "on";
  const shutdownDrainMs = deps.shutdownDrainMs ?? env.SERVER_SHUTDOWN_DRAIN_MS;
  const probeNativeQuota = deps.probeNativeQuotaHttp
    ?? (() => probeNativeQuotaHttp({ production: envName === "production" }));
  const initRoot = deps.initRootConnection ?? initRootConnection;
  const verifyNativeQuota = deps.verifyNativeQuotaRootHandshake
    ?? verifyNativeQuotaRootHandshake;
  const ensureSchema = deps.ensureSystemSchema ?? ensureSystemSchema;
  const ensureContentSchema = deps.ensurePlatformContentSchema
    ?? (envName === "test" ? async () => undefined : () => ensurePlatformContentSchema());
  const assertContentMigrated = deps.assertLegacyContentMigrated
    ?? (envName === "test" ? async () => undefined : async () => {
      await assertLegacyContentMigrated(
        await getRootDatabaseSession("_system"),
        await getRootDatabaseSession(env.CONTENT_DATABASE),
        { deepVerify: false },
      );
    });
  // 逐行比对耗时较长，用独占会话，避免共享池按 LRU 回收正在使用的会话。
  const verifyContentCopy = deps.verifyLegacyContentCopy
    ?? (envName === "test" ? async () => undefined : () => withRootDatabaseSessions(async (get) => {
      await assertLegacyContentMigrated(
        await get("_system", env.SURREAL_NS),
        await get(env.CONTENT_DATABASE, env.SURREAL_NS),
      );
    }));
  const initPublisher = deps.initContentPublisherSession
    ?? (envName === "test" ? async () => undefined : initContentPublisherSession);
  const initProjection = deps.initContentProjectionSession
    ?? (envName === "test" ? async () => undefined : initContentProjectionSession);
  const defineReader = deps.defineContentReaderAccess
    ?? (envName === "test" ? async () => undefined : async () => defineContentReaderAccess(
      await getRootDatabaseSession(env.CONTENT_DATABASE),
      { jwksUrl: env.OIDC_JWKS_URL, issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE },
    ));
  const reconcileContentCitations = deps.reconcileCitationResolutions
    ?? (envName === "test"
      ? async () => undefined
      : () => reconcileCitationResolutions(contentPublisherQuery));
  const seedAdmins = deps.seedSystemAdmins ?? seedSystemAdmins;
  const seedOperators = deps.seedPlatformOperators
    ?? (envName === "test" ? async () => undefined : seedPlatformOperators);
  const seedPlans = deps.seedQuotaPlans ?? seedQuotaPlans;
  const migrateWorkspaces = deps.migrateAllWorkspaces ?? migrateAllWorkspaces;
  const makeApp = deps.createApp ?? createApp;
  const serve =
    deps.serve ??
    ((options: { hostname: string; port: number; fetch: AppLike["fetch"] }) =>
      Bun.serve(options as Parameters<typeof Bun.serve>[0]));
  const startReconcile = deps.startReconcileLoop ?? startReconcileLoop;
  const startFunnel = deps.startFunnelLoop
    ?? (envName === "test" ? () => ({ stop() {} }) : startFunnelLoop);
  const startQuota = deps.startQuotaRuntime
    ?? (envName === "test"
      ? () => ({ stop() {} })
      : startNativeQuotaRuntime);
  const startClaimsRisk = deps.startClaimsRiskDispatcher
    ?? (envName === "test" ? () => ({ async stop() {} }) : startClaimsRiskReminderDispatcher);
  const startOffice = deps.startOfficeReconciler
    ?? (envName === "test" ? () => ({ async stop() {} }) : startOfficeReconciler);
  const startReaper = deps.startTestSubjectReaper
    ?? (envName === "test" ? () => ({ stop() {} }) : () => {
        // 测试主体清理心跳：每轮扫到期 workspace/test_subject，失败只告警。
        const intervalMs = env.TEST_SUBJECT_REAPER_INTERVAL_SEC * 1000;
        let stopped = false;
        const cancelIdpProvision = createIdpProvisionCancellation(createIdpAdminClientFromEnv({
          secretStore: createPlatformSecretStore(env.PLATFORM_SECRET_KEY),
        }));
        const tick = async (sweep: (deps: TestSubjectReaperDeps) => Promise<unknown>) => {
          try {
            await sweep({
              systemDb: {
                async query(sql, params) {
                  return (await getRootDatabaseSession("_system")).query(sql, params);
                },
              },
              dropDatabase: removeRootWorkspaceDatabase,
              cancelIdpProvision,
            });
          } catch (cause) {
            console.error("[test-subject-reaper] sweep failed; retry next tick", {
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        };
        const expire = () => { void tick(runTestSubjectReaper); };
        let cleaning = false;
        const cleanup = async () => {
          if (cleaning) return;
          cleaning = true;
          try { await tick(runFailedTestKitInvitationReaper); } finally { cleaning = false; }
        };
        expire();
        void cleanup();
        const timer = setInterval(expire, intervalMs);
        const cleanupTimer = setInterval(() => { void cleanup(); }, 60_000);
        return { stop: () => {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          clearInterval(cleanupTimer);
        } };
      });
  const closeRoot = deps.closeRootConnection ?? closeRootConnection;
  const initProbe = deps.initHealthProbe
    ?? (envName === "test" ? async () => undefined : initHealthProbe);
  const closeProbe = deps.closeHealthProbe ?? closeHealthProbe;

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
  // /health 专用探测连接：init 失败不阻塞启动（root 已证明 DB 可达），
  // 既有自动重连兜底；连接真正断开期间 /health 如实 down。
  try {
    await initProbe();
  } catch (cause) {
    console.error("[server] health probe connection init failed; relying on auto-reconnect", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  await bootStep("system-schema", ensureSchema);
  await bootStep("content-schema", ensureContentSchema);
  await bootStep("content-migrated", assertContentMigrated);
  await bootStep("content-publisher", initPublisher);
  await bootStep("content-reader", defineReader);
  await bootStep("content-projection", initProjection);
  await bootStep("seed-admins", seedAdmins);
  await bootStep("seed-operators", seedOperators);
  await bootStep("seed-plans", seedPlans);
  await bootStep("workspace-migrations", migrateWorkspaces);

  let quotaRuntime: NativeQuotaRuntimeHandle;
  try {
    quotaRuntime = backgroundWorkers ? startQuota() : { stop() {} };
  } catch (cause) {
    try {
      await closeRoot();
    } catch (closeCause) {
      console.error("[server] failed to close root after quota runtime failure", {
        message: closeCause instanceof Error ? closeCause.message : String(closeCause),
      });
    }
    console.error("[server] failed to start native quota runtime; refusing traffic", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }

  const app = makeApp();
  const server = serve({
    hostname: host,
    port,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const nativeMeetingGc = envName === "test" || !backgroundWorkers ? undefined : startNativeMeetingGc();

  console.info("[server] listening", { host, port, env: envName, backgroundWorkers });

  const handles = backgroundWorkers ? startBackgroundWorkers() : {};
  // 引用解析校对是可重放的派生数据，扫描全部引用需数分钟：放到监听之后由正式进程后台跑，桥接进程不跑。
  const citationReconcile = backgroundWorkers ? runCitationReconcile() : undefined;
  // 旧内容逐行比对同理：启动前只检查迁移标记，完整比对由正式进程监听后后台跑。
  const contentCopyAudit = backgroundWorkers ? runAfterListen("content-copy-audit", verifyContentCopy) : undefined;
  const { reconcileLoop, funnelLoop, claimsRiskDispatcher, testSubjectReaper, officeReconciler } = handles;

  return {
    server,
    async shutdown(signal: string): Promise<void> {
      console.info("[server] shutting down", { signal });
      // 先停监听并排空在途请求，再停后台循环、关数据库连接：关停窗口内的请求不会撞上已关闭的 root。
      await drainServer(server, shutdownDrainMs);
      reconcileLoop?.stop();
      funnelLoop?.stop();
      await nativeMeetingGc?.stop();
      quotaRuntime.stop();
      testSubjectReaper?.stop();
      await claimsRiskDispatcher?.stop();
      await officeReconciler?.stop();
      if (backgroundWorkers) {
        await stopEmployeeTriggerRuntime({
          deadlineMs: env.EMPLOYEE_RUNTIME_SHUTDOWN_DEADLINE_MS,
        });
        await stopEmployeeRuntime();
      }
      citationReconcile?.abandon();
      contentCopyAudit?.abandon();
      await (deps.closeContentPublisherSession ?? closeContentPublisherSession)();
      await (deps.closeContentProjectionSession ?? closeContentProjectionSession)();
      await closeProbe();
      await closeRoot();
    },
  };

  async function bootStep(step: string, run: () => Promise<unknown>): Promise<void> {
    const startedAt = Date.now();
    // 启动步骤均幂等；发布桥接时与旧进程并发写同一批记录，事务冲突整步重试。
    await retryAtomicConflict(run);
    if (envName !== "test") console.info("[server] boot step", { step, durationMs: Date.now() - startedAt });
  }

  function runCitationReconcile(): { abandon(): void } {
    let abandoned = false;
    const startedAt = Date.now();
    reconcileContentCitations().then(
      (result) => {
        if (envName !== "test") {
          console.info("[platform-content] citation resolutions reconciled", { result, durationMs: Date.now() - startedAt });
        }
      },
      (cause: unknown) => {
        if (abandoned) return;
        console.error("[platform-content] citation resolution reconciliation failed after startup", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return { abandon: () => { abandoned = true; } };
  }

  function runAfterListen(step: string, run: () => Promise<unknown>): { abandon(): void } {
    let abandoned = false;
    const startedAt = Date.now();
    run().then(
      () => {
        if (envName !== "test") console.info("[server] post-listen step", { step, durationMs: Date.now() - startedAt });
      },
      (cause: unknown) => {
        if (abandoned) return;
        console.error("[server] post-listen step failed", {
          step,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return { abandon: () => { abandoned = true; } };
  }

  function startBackgroundWorkers(): BackgroundWorkerHandles {
    // 校对心跳不阻塞 boot：启动失败只告警，server 照常对外服务（下次重启再试）。
    let reconcileLoop: ReconcileLoopHandle | undefined;
    try {
      reconcileLoop = startReconcile();
    } catch (cause) {
      console.error("[server] failed to start reconcile heartbeat; continuing without it", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // 漏斗聚合心跳不阻塞 boot：失败只告警，下个周期重试。
    let funnelLoop: FunnelLoopHandle | undefined;
    try {
      funnelLoop = startFunnel();
    } catch (cause) {
      console.error("[server] failed to start funnel aggregation loop; continuing without it", {
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

    let testSubjectReaper: { stop(): void } | undefined;
    try {
      testSubjectReaper = startReaper();
    } catch (cause) {
      console.error("[server] failed to start test-subject reaper; continuing without it", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    let officeReconciler: OfficeReconcilerHandle | undefined;
    try {
      officeReconciler = startOffice();
    } catch (cause) {
      console.error("[server] failed to start office reconciler; continuing without it", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    // 虚拟员工 runtime 启动监督（VER06）：回装 secret 缓存 + 分批 reconcile
    // active 员工的孤儿触发；失败不阻塞对外服务，进度经运维端点可观测。
    void startEmployeeSupervision();

    return { reconcileLoop, funnelLoop, claimsRiskDispatcher, testSubjectReaper, officeReconciler };
  }
}

type BackgroundWorkerHandles = {
  reconcileLoop?: ReconcileLoopHandle;
  funnelLoop?: FunnelLoopHandle;
  claimsRiskDispatcher?: ClaimsRiskDispatcherHandle;
  testSubjectReaper?: { stop(): void };
  officeReconciler?: OfficeReconcilerHandle;
};

async function drainServer(server: ServerHandle, drainMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = Promise.resolve(server.stop()).then(() => true);
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), drainMs);
  });
  const finished = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  if (!finished) {
    console.warn("[server] in-flight requests still open after drain window; closing them", { drainMs });
    await server.stop(true);
  }
}
