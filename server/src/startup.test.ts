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

    expect(calls).toEqual(["init-root", "ensure-system-schema", "migrate-workspaces", "create-app", "listen"]);
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

    expect(calls).toEqual(["init-root", "ensure-system-schema", "migrate-workspaces"]);
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
});
