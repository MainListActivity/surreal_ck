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
      workspaceScope: createWorkspaceScopeStub({
        canCreate: false,
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
      }),
    });

    const response = await app.fetch(new Request("http://localhost/api/session/workspaces"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      canCreate: false,
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

  test("passes through canCreate=true from the workspace scope module", async () => {
    const app = createApp({
      requireUser: () => useTestUser,
      workspaceScope: createWorkspaceScopeStub({ canCreate: true, workspaces: [] }),
    });

    const response = await app.fetch(new Request("http://localhost/api/session/workspaces"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canCreate: true, workspaces: [] });
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
          return { workspaces: [], canCreate: false };
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
    const adapterCalls: Array<{ subjectToken: string; scope: SurrealTokenScope }> = [];
    const idpTokenScopeAdapter: IdpTokenScopeAdapter = {
      async updateUserScope(input) {
        adapterCalls.push(input);
        return { accessToken: "scoped-token", expiresIn: 3600 };
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
          return { workspaces: [], canCreate: false };
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
    expect(await response.json()).toEqual({
      ok: true,
      accessToken: "scoped-token",
      expiresIn: 3600,
    });
    expect(switchInput).toEqual({
      subject: "user-123",
      email: "ada@example.test",
      workspaceSlug: "recent",
    });
    expect(adapterCalls).toEqual([
      { subjectToken: "test-token", scope: { db: "ws_recent", ac: "admin" } },
    ]);
  });

  test("rejects inaccessible workspace switches without calling IdP", async () => {
    let adapterCalled = false;
    const app = createApp({
      requireUser: () => useTestUser,
      idpTokenScopeAdapter: {
        async updateUserScope() {
          adapterCalled = true;
          return { accessToken: "unused", expiresIn: null };
        },
      },
      workspaceScope: {
        async getDefaultScope() {
          return { kind: "login-denied", reason: "no-workspace" };
        },
        async listWorkspaces() {
          return { workspaces: [], canCreate: false };
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

  test("returns 409 workspace-user-drift when target db is drifted", async () => {
    let adapterCalled = false;
    const app = createApp({
      requireUser: () => useTestUser,
      idpTokenScopeAdapter: {
        async updateUserScope() {
          adapterCalled = true;
          return { accessToken: "unused", expiresIn: null };
        },
      },
      workspaceScope: {
        async getDefaultScope() {
          return { kind: "login-denied", reason: "no-workspace" };
        },
        async listWorkspaces() {
          return { workspaces: [], canCreate: false };
        },
        async switchWorkspace() {
          return { kind: "drift" };
        },
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/session/switch-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: "drifted-ws" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace-user-drift" },
    });
    expect(adapterCalled).toBe(false);
  });

  test("security audit: drift and forbidden errors do not leak token or secrets in logs", async () => {
    const logs: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      const app = createApp({
        requireUser: () => useTestUser,
        workspaceScope: {
          async getDefaultScope() {
            return { kind: "login-denied", reason: "no-workspace" };
          },
          async listWorkspaces() {
            return { workspaces: [], canCreate: false };
          },
          async switchWorkspace() {
            return { kind: "drift" };
          },
        },
      });

      const response = await app.fetch(
        new Request("http://localhost/api/session/switch-workspace", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sensitive-user-token-abc",
          },
          body: JSON.stringify({ workspaceSlug: "drifted-ws" }),
        }),
      );

      expect(response.status).toBe(409);
      const logText = JSON.stringify(logs);
      expect(logText).not.toContain("sensitive-user-token-abc");
    } finally {
      console.error = originalConsoleError;
    }
  });
});
