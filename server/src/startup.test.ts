import { describe, expect, test } from "bun:test";
import { startServer } from "./startup";
import { QueryError } from "surrealdb";

describe("server startup", () => {
  test("ensures the system schema before listening", async () => {
    const calls: string[] = [];

    await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {
        calls.push("quota-http");
      },
      initRootConnection: async () => {
        calls.push("init-root");
      },
      verifyNativeQuotaRootHandshake: async () => {
        calls.push("quota-root-info");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
      },
      seedQuotaPlans: async () => {
        calls.push("seed-plans");
      },
      migrateAllWorkspaces: async () => {
        calls.push("migrate-workspaces");
        return { total: 0, migrated: [] };
      },
      createApp: () => {
        calls.push("create-app");
        return { fetch: () => new Response("ok") };
      },
      serve: () => {
        calls.push("listen");
        return { stop: () => calls.push("stop") };
      },
      closeRootConnection: async () => {
        calls.push("close-root");
      },
    });

    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
      "seed-admins",
      "seed-plans",
      "migrate-workspaces",
      "create-app",
      "listen",
    ]);
  });

  test("starts the reconcile heartbeat after the server is listening", async () => {
    const calls: string[] = [];

    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {
        calls.push("quota-http");
      },
      initRootConnection: async () => {
        calls.push("init-root");
      },
      verifyNativeQuotaRootHandshake: async () => {
        calls.push("quota-root-info");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
      },
      seedQuotaPlans: async () => {
        calls.push("seed-plans");
      },
      migrateAllWorkspaces: async () => {
        calls.push("migrate-workspaces");
        return { total: 0, migrated: [] };
      },
      createApp: () => {
        calls.push("create-app");
        return { fetch: () => new Response("ok") };
      },
      serve: () => {
        calls.push("listen");
        return { stop: () => calls.push("stop") };
      },
      startReconcileLoop: () => {
        calls.push("reconcile-loop");
        return { stop: () => calls.push("reconcile-stop") };
      },
      closeRootConnection: async () => {
        calls.push("close-root");
      },
    });

    // reconcile loop 在监听之后启动，不阻塞 boot
    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
      "seed-admins",
      "seed-plans",
      "migrate-workspaces",
      "create-app",
      "listen",
      "reconcile-loop",
    ]);

    // shutdown 应停掉心跳并关闭 root
    await running.shutdown("SIGTERM");
    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
      "seed-admins",
      "seed-plans",
      "migrate-workspaces",
      "create-app",
      "listen",
      "reconcile-loop",
      "stop",
      "reconcile-stop",
      "close-root",
    ]);
  });

  test("监听后启动债权风险 dispatcher，关停时等待执行窗口收尾", async () => {
    const calls: string[] = [];
    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {},
      initRootConnection: async () => {},
      verifyNativeQuotaRootHandshake: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
      seedQuotaPlans: async () => {},
      migrateAllWorkspaces: async () => ({ total: 0, migrated: [] }),
      createApp: () => ({ fetch: () => new Response("ok") }),
      serve: () => ({ stop: () => calls.push("server:stop") }),
      startReconcileLoop: () => ({ stop: () => {} }),
      startClaimsRiskDispatcher: () => {
        calls.push("claims-risk:start");
        return { async stop() { calls.push("claims-risk:stop"); } };
      },
      closeRootConnection: async () => { calls.push("root:close"); },
    });

    await running.shutdown("SIGTERM");

    expect(calls).toEqual([
      "claims-risk:start",
      "server:stop",
      "claims-risk:stop",
      "root:close",
    ]);
  });

  test("监听前启动原生配额 runtime，并在 root 连接关闭前停止", async () => {
    const calls: string[] = [];
    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {},
      initRootConnection: async () => {},
      verifyNativeQuotaRootHandshake: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
      seedQuotaPlans: async () => {},
      migrateAllWorkspaces: async () => ({ total: 0, migrated: [] }),
      createApp: () => ({ fetch: () => new Response("ok") }),
      serve: () => {
        calls.push("server:start");
        return { stop: () => calls.push("server:stop") };
      },
      startReconcileLoop: () => ({ stop: () => {} }),
      startQuotaRuntime: () => {
        calls.push("quota:start");
        return { stop() {
          calls.push("quota:stop");
        } };
      },
      closeRootConnection: async () => {
        calls.push("root:close");
      },
    });

    await running.shutdown("SIGTERM");

    expect(calls).toEqual([
      "quota:start",
      "server:start",
      "server:stop",
      "quota:stop",
      "root:close",
    ]);
  });

  test("关停先停监听并等待在途请求排空，再停后台任务、关闭 root", async () => {
    const calls: string[] = [];
    let finishDrain = () => {};
    const running = await startServer({
      ...minimalDeps(),
      serve: () => ({
        stop: () => {
          calls.push("server:stop");
          return new Promise<void>((resolve) => {
            finishDrain = () => {
              calls.push("server:drained");
              resolve();
            };
          });
        },
      }),
      startQuotaRuntime: () => ({ stop: () => calls.push("quota:stop") }),
      closeRootConnection: async () => { calls.push("root:close"); },
    });

    const shutdown = running.shutdown("SIGTERM");
    await Bun.sleep(5);
    expect(calls).toEqual(["server:stop"]);
    finishDrain();
    await shutdown;

    expect(calls).toEqual(["server:stop", "server:drained", "quota:stop", "root:close"]);
  });

  test("排空超时后强制断开在途连接，再关闭 root", async () => {
    const calls: string[] = [];
    const running = await startServer({
      ...minimalDeps(),
      shutdownDrainMs: 10,
      serve: () => ({
        stop: (closeActiveConnections?: boolean) => {
          calls.push(closeActiveConnections ? "server:stop-force" : "server:stop");
          return closeActiveConnections ? Promise.resolve() : new Promise<void>(() => {});
        },
      }),
      closeRootConnection: async () => { calls.push("root:close"); },
    });

    await running.shutdown("SIGTERM");

    expect(calls).toEqual(["server:stop", "server:stop-force", "root:close"]);
  });

  test("backgroundWorkers=false（发布桥接进程）只服务 HTTP，不启动任何后台循环", async () => {
    const calls: string[] = [];
    const running = await startServer({
      ...minimalDeps(),
      backgroundWorkers: false,
      serve: () => {
        calls.push("listen");
        return { stop: () => calls.push("server:stop") };
      },
      startQuotaRuntime: () => {
        calls.push("quota:start");
        return { stop() {} };
      },
      startReconcileLoop: () => {
        calls.push("reconcile:start");
        return { stop: () => {} };
      },
      startClaimsRiskDispatcher: () => {
        calls.push("claims-risk:start");
        return { async stop() {} };
      },
      closeRootConnection: async () => { calls.push("root:close"); },
    });

    await running.shutdown("SIGTERM");

    expect(calls).toEqual(["listen", "server:stop", "root:close"]);
  });

  test("启动步骤遇到可重试事务冲突时整步重试", async () => {
    let attempts = 0;
    const running = await startServer({
      ...minimalDeps(),
      seedQuotaPlans: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new QueryError({ code: -32000, message: "There was a problem with the key-value store: Transaction conflict: x. This transaction can be retried" });
        }
      },
      serve: () => ({ stop: () => {} }),
    });
    await running.shutdown("SIGTERM");
    expect(attempts).toBe(2);
  });

  test("引用解析校对在监听之后后台运行，桥接进程不运行", async () => {
    for (const backgroundWorkers of [true, false]) {
      const calls: string[] = [];
      const running = await startServer({
        ...minimalDeps(),
        backgroundWorkers,
        reconcileCitationResolutions: async () => { calls.push("citations"); },
        serve: () => {
          calls.push("listen");
          return { stop: () => {} };
        },
      });
      await Bun.sleep(0);
      await running.shutdown("SIGTERM");
      expect(calls).toEqual(backgroundWorkers ? ["listen", "citations"] : ["listen"]);
    }
  });

  test("原生配额 runtime 启动失败时关闭 root 且不监听", async () => {
    const calls: string[] = [];
    const failure = new Error("quota-runtime-failed");

    await expect(startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {},
      initRootConnection: async () => {},
      verifyNativeQuotaRootHandshake: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
      seedQuotaPlans: async () => {},
      migrateAllWorkspaces: async () => ({ total: 0, migrated: [] }),
      createApp: () => {
        calls.push("create-app");
        return { fetch: () => new Response("ok") };
      },
      serve: () => {
        calls.push("server:start");
        return { stop: () => {} };
      },
      startQuotaRuntime: () => {
        calls.push("quota:start");
        throw failure;
      },
      closeRootConnection: async () => {
        calls.push("root:close");
      },
    })).rejects.toBe(failure);

    expect(calls).toEqual(["quota:start", "root:close"]);
  });

  test("still listens when starting the reconcile heartbeat throws", async () => {
    const calls: string[] = [];

    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {
        calls.push("quota-http");
      },
      initRootConnection: async () => {
        calls.push("init-root");
      },
      verifyNativeQuotaRootHandshake: async () => {
        calls.push("quota-root-info");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
      },
      seedQuotaPlans: async () => {
        calls.push("seed-plans");
      },
      migrateAllWorkspaces: async () => {
        calls.push("migrate-workspaces");
        return { total: 0, migrated: [] };
      },
      createApp: () => {
        calls.push("create-app");
        return { fetch: () => new Response("ok") };
      },
      serve: () => {
        calls.push("listen");
        return { stop: () => calls.push("stop") };
      },
      startReconcileLoop: () => {
        calls.push("reconcile-loop");
        throw new Error("reconcile loop boot boom");
      },
      closeRootConnection: async () => {
        calls.push("close-root");
      },
    });

    // 心跳启动抛错被吞：server 仍正常返回、已监听
    expect(running.server).toBeDefined();
    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
      "seed-admins",
      "seed-plans",
      "migrate-workspaces",
      "create-app",
      "listen",
      "reconcile-loop",
    ]);

    // shutdown 不应因缺少 loop handle 而崩
    await running.shutdown("SIGTERM");
    expect(calls).toContain("close-root");
  });

  test("does not listen when workspace migration fails", async () => {
    const calls: string[] = [];

    await expect(
      startServer({
        host: "127.0.0.1",
        port: 18080,
        envName: "test",
        probeNativeQuotaHttp: async () => {
          calls.push("quota-http");
        },
        initRootConnection: async () => {
          calls.push("init-root");
        },
        verifyNativeQuotaRootHandshake: async () => {
          calls.push("quota-root-info");
        },
        ensureSystemSchema: async () => {
          calls.push("ensure-system-schema");
        },
        seedSystemAdmins: async () => {
          calls.push("seed-admins");
        },
        seedQuotaPlans: async () => {
          calls.push("seed-plans");
        },
        migrateAllWorkspaces: async () => {
          calls.push("migrate-workspaces");
          throw new Error("workspace migration failed on ws_broken (0/1 migrated before failure)");
        },
        createApp: () => {
          calls.push("create-app");
          return { fetch: () => new Response("ok") };
        },
        serve: () => {
          calls.push("listen");
          return { stop: () => calls.push("stop") };
        },
        closeRootConnection: async () => {
          calls.push("close-root");
        },
      }),
    ).rejects.toThrow("workspace migration failed");

    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
      "seed-admins",
      "seed-plans",
      "migrate-workspaces",
    ]);
  });

  test("does not listen when system schema seed fails", async () => {
    const calls: string[] = [];

    await expect(
      startServer({
        host: "127.0.0.1",
        port: 18080,
        envName: "test",
        probeNativeQuotaHttp: async () => {
          calls.push("quota-http");
        },
        initRootConnection: async () => {
          calls.push("init-root");
        },
        verifyNativeQuotaRootHandshake: async () => {
          calls.push("quota-root-info");
        },
        ensureSystemSchema: async () => {
          calls.push("ensure-system-schema");
          throw new Error("SurrealDB unavailable");
        },
        createApp: () => {
          calls.push("create-app");
          return { fetch: () => new Response("ok") };
        },
        serve: () => {
          calls.push("listen");
          return { stop: () => calls.push("stop") };
        },
        closeRootConnection: async () => {
          calls.push("close-root");
        },
      }),
    ).rejects.toThrow("SurrealDB unavailable");

    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "ensure-system-schema",
    ]);
  });

  test("把 app 的 websocket handler 透传给 Bun.serve（WS endpoint 才能升级）", async () => {
    const wsHandler = { open() {}, close() {}, message() {} };
    let servedWebSocket: unknown;

    await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      probeNativeQuotaHttp: async () => {},
      initRootConnection: async () => {},
      verifyNativeQuotaRootHandshake: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
      seedQuotaPlans: async () => {},
      migrateAllWorkspaces: async () => ({ total: 0, migrated: [] }),
      createApp: () => ({ fetch: () => new Response("ok"), websocket: wsHandler }),
      serve: (options: { websocket?: unknown }) => {
        servedWebSocket = options.websocket;
        return { stop: () => {} };
      },
      closeRootConnection: async () => {},
    });

    expect(servedWebSocket).toBe(wsHandler);
  });

  test("capability gate failure keeps migrations, app, scope routes and listener unavailable", async () => {
    const calls: string[] = [];

    await expect(
      startServer({
        host: "127.0.0.1",
        port: 18080,
        envName: "test",
        probeNativeQuotaHttp: async () => {
          calls.push("quota-http");
          throw new Error("incompatible native quota capability");
        },
        initRootConnection: async () => {
          calls.push("init-root");
        },
        verifyNativeQuotaRootHandshake: async () => {
          calls.push("quota-root-info");
        },
        ensureSystemSchema: async () => {
          calls.push("ensure-system-schema");
        },
        seedSystemAdmins: async () => {
          calls.push("seed-admins");
        },
        seedQuotaPlans: async () => {
          calls.push("seed-plans");
        },
        migrateAllWorkspaces: async () => {
          calls.push("migrate-workspaces");
        },
        createApp: () => {
          calls.push("create-app");
          return { fetch: () => new Response("ok") };
        },
        serve: () => {
          calls.push("listen");
          return { stop() {} };
        },
      }),
    ).rejects.toThrow("incompatible native quota capability");

    expect(calls).toEqual(["quota-http"]);
  });

  test("root INFO gate failure closes root and does not run schema migrations", async () => {
    const calls: string[] = [];

    await expect(
      startServer({
        host: "127.0.0.1",
        port: 18080,
        envName: "test",
        probeNativeQuotaHttp: async () => {
          calls.push("quota-http");
        },
        initRootConnection: async () => {
          calls.push("init-root");
        },
        verifyNativeQuotaRootHandshake: async () => {
          calls.push("quota-root-info");
          throw new Error("untrusted quota ledger");
        },
        closeRootConnection: async () => {
          calls.push("close-root");
        },
        ensureSystemSchema: async () => {
          calls.push("ensure-system-schema");
        },
        createApp: () => {
          calls.push("create-app");
          return { fetch: () => new Response("ok") };
        },
        serve: () => {
          calls.push("listen");
          return { stop() {} };
        },
      }),
    ).rejects.toThrow("untrusted quota ledger");

    expect(calls).toEqual([
      "quota-http",
      "init-root",
      "quota-root-info",
      "close-root",
    ]);
  });
});

function minimalDeps() {
  return {
    host: "127.0.0.1",
    port: 18080,
    envName: "test",
    probeNativeQuotaHttp: async () => {},
    initRootConnection: async () => {},
    verifyNativeQuotaRootHandshake: async () => {},
    ensureSystemSchema: async () => {},
    seedSystemAdmins: async () => {},
    seedQuotaPlans: async () => {},
    migrateAllWorkspaces: async () => ({ total: 0, migrated: [] }),
    createApp: () => ({ fetch: () => new Response("ok") }),
    startReconcileLoop: () => ({ stop: () => {} }),
  };
}
