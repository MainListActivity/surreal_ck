import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: {},
  rawToken: "test-token",
};

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", testUser);
  await next();
};

function createWorkspaceScopeStub(workspaces: Awaited<ReturnType<WorkspaceScopeModule["listWorkspaces"]>>): WorkspaceScopeModule {
  return {
    async getDefaultScope() {
      return { kind: "login-denied", reason: "no-workspace" };
    },
    async listWorkspaces() {
      return workspaces;
    },
  };
}

describe("session workspace list", () => {
  test("returns current user's active workspaces in most-recent-first order", async () => {
    const app = createApp({
      requireUser: () => useTestUser,
      workspaceScope: createWorkspaceScopeStub([
        {
          slug: "recent",
          name: "Recent workspace",
          dbName: "ws_recent",
          role: "admin",
          lastSelectedAt: "2026-05-20T00:00:00.000Z",
        },
        {
          slug: "older",
          name: "Older workspace",
          dbName: "ws_older",
          role: "participant",
          lastSelectedAt: "2026-05-10T00:00:00.000Z",
        },
        {
          slug: "never",
          name: "Never selected",
          dbName: "ws_never",
          role: "participant",
          lastSelectedAt: null,
        },
      ]),
    });

    const response = await app.fetch(new Request("http://localhost/api/session/workspaces"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaces: [
        {
          slug: "recent",
          name: "Recent workspace",
          dbName: "ws_recent",
          role: "admin",
          lastSelectedAt: "2026-05-20T00:00:00.000Z",
        },
        {
          slug: "older",
          name: "Older workspace",
          dbName: "ws_older",
          role: "participant",
          lastSelectedAt: "2026-05-10T00:00:00.000Z",
        },
        {
          slug: "never",
          name: "Never selected",
          dbName: "ws_never",
          role: "participant",
          lastSelectedAt: null,
        },
      ],
    });
  });

  test("requires OIDC before listing workspaces", async () => {
    let listCalled = false;
    const app = createApp({
      workspaceScope: {
        async getDefaultScope() {
          return { kind: "login-denied", reason: "no-workspace" };
        },
        async listWorkspaces() {
          listCalled = true;
          return [];
        },
      },
    });

    const response = await app.fetch(new Request("http://localhost/api/session/workspaces"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "oidc-missing" },
    });
    expect(listCalled).toBe(false);
  });
});
