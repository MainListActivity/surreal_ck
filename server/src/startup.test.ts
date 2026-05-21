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

    expect(calls).toEqual(["init-root", "ensure-system-schema", "create-app", "listen"]);
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
