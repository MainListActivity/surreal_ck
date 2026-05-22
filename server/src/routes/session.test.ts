import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { IdpTokenScopeAdapter } from "../workspaces/idp-scope-adapter";
import type { SurrealTokenScope, WorkspaceScopeModule } from "../workspaces/workspace-scope";

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
    async switchWorkspace() {
      return { kind: "forbidden" };
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
        async switchWorkspace() {
          return { kind: "forbidden" };
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

describe("session workspace switch", () => {
  test("switches to an accessible workspace and asks IdP to update the token scope", async () => {
    let switchInput: unknown;
    const adapterCalls: Array<{ subject: string; scope: SurrealTokenScope }> = [];
    const idpTokenScopeAdapter: IdpTokenScopeAdapter = {
      async updateUserScope(subject, scope) {
        adapterCalls.push({ subject, scope });
      },
    };
    const app = createApp({
      requireUser: () => useTestUser,
      idpTokenScopeAdapter,
      workspaceScope: {
        async getDefaultScope() {
          return { kind: "login-denied", reason: "no-workspace" };
        },
        async listWorkspaces() {
          return [];
        },
        async switchWorkspace(input) {
          switchInput = input;
          return { kind: "switched", scope: { db: "ws_recent", ac: "admin" } };
        },
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/session/switch-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "recent" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, refreshRequired: true });
    expect(switchInput).toEqual({ subject: "user-123", workspaceSlug: "recent" });
    expect(adapterCalls).toEqual([{ subject: "user-123", scope: { db: "ws_recent", ac: "admin" } }]);
  });

  test("rejects inaccessible workspace switches without calling IdP", async () => {
    let adapterCalled = false;
    const app = createApp({
      requireUser: () => useTestUser,
      idpTokenScopeAdapter: {
        async updateUserScope() {
          adapterCalled = true;
        },
      },
      workspaceScope: {
        async getDefaultScope() {
          return { kind: "login-denied", reason: "no-workspace" };
        },
        async listWorkspaces() {
          return [];
        },
        async switchWorkspace() {
          return { kind: "forbidden" };
        },
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/session/switch-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "not-mine" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace-forbidden" },
    });
    expect(adapterCalled).toBe(false);
  });
});
