import { describe, expect, test } from "bun:test";
import { startServer } from "./startup";

describe("server startup", () => {
  test("ensures the system schema before listening", async () => {
    const calls: string[] = [];

    await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      initRootConnection: async () => {
        calls.push("init-root");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
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

    expect(calls).toEqual(["init-root", "ensure-system-schema", "seed-admins", "migrate-workspaces", "create-app", "listen"]);
  });

  test("starts the reconcile heartbeat after the server is listening", async () => {
    const calls: string[] = [];

    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      initRootConnection: async () => {
        calls.push("init-root");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
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
      "init-root",
      "ensure-system-schema",
      "seed-admins",
      "migrate-workspaces",
      "create-app",
      "listen",
      "reconcile-loop",
    ]);

    // shutdown 应停掉心跳并关闭 root
    await running.shutdown("SIGTERM");
    expect(calls).toEqual([
      "init-root",
      "ensure-system-schema",
      "seed-admins",
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
      initRootConnection: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
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

  test("still listens when starting the reconcile heartbeat throws", async () => {
    const calls: string[] = [];

    const running = await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      initRootConnection: async () => {
        calls.push("init-root");
      },
      ensureSystemSchema: async () => {
        calls.push("ensure-system-schema");
      },
      seedSystemAdmins: async () => {
        calls.push("seed-admins");
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
      "init-root",
      "ensure-system-schema",
      "seed-admins",
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
        initRootConnection: async () => {
          calls.push("init-root");
        },
        ensureSystemSchema: async () => {
          calls.push("ensure-system-schema");
        },
        seedSystemAdmins: async () => {
          calls.push("seed-admins");
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

    expect(calls).toEqual(["init-root", "ensure-system-schema", "seed-admins", "migrate-workspaces"]);
  });

  test("does not listen when system schema seed fails", async () => {
    const calls: string[] = [];

    await expect(
      startServer({
        host: "127.0.0.1",
        port: 18080,
        envName: "test",
        initRootConnection: async () => {
          calls.push("init-root");
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

    expect(calls).toEqual(["init-root", "ensure-system-schema"]);
  });

  test("把 app 的 websocket handler 透传给 Bun.serve（WS endpoint 才能升级）", async () => {
    const wsHandler = { open() {}, close() {}, message() {} };
    let servedWebSocket: unknown;

    await startServer({
      host: "127.0.0.1",
      port: 18080,
      envName: "test",
      initRootConnection: async () => {},
      ensureSystemSchema: async () => {},
      seedSystemAdmins: async () => {},
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
});
