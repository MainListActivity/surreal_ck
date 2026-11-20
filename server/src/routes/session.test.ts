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
    async resolveCollaborationScope() {
      return { kind: "forbidden" };
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
        async resolveCollaborationScope() {
          return { kind: "forbidden" };
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
        async resolveCollaborationScope() {
          return { kind: "forbidden" };
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
        async resolveCollaborationScope() {
          return { kind: "forbidden" };
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
        async resolveCollaborationScope() {
          return { kind: "forbidden" };
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

  test("returns 502 without leaking the OIDC token to logs or response when IdP exchange fails", async () => {
    const logs: string[] = [];
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    console.error = (...args: unknown[]) => {
      logs.push(Bun.inspect(args));
    };
    console.log = (...args: unknown[]) => {
      logs.push(Bun.inspect(args));
    };

    const useSensitiveUser: MiddlewareHandler<AppBindings> = async (c, next) => {
      c.set("user", { ...testUser, rawToken: "sensitive-user-token-abc" });
      await next();
    };

    try {
      const app = createApp({
        requireUser: () => useSensitiveUser,
        idpTokenScopeAdapter: {
          async updateUserScope() {
            // 模拟未脱敏的上游错误：message 直接含 subject token。
            throw new Error(
              'IdP scope update failed with 400, {"subject_token":"sensitive-user-token-abc"}',
            );
          },
        },
        workspaceScope: {
          async getDefaultScope() {
            return { kind: "login-denied", reason: "no-workspace" };
          },
          async listWorkspaces() {
            return { workspaces: [], canCreate: false };
          },
          async resolveCollaborationScope() {
            return { kind: "forbidden" };
          },
          async switchWorkspace() {
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

      expect(response.status).toBe(502);
      const responseText = JSON.stringify(await response.json());
      expect(responseText).toContain("idp-scope-exchange-failed");
      expect(responseText).not.toContain("sensitive-user-token-abc");

      const logText = logs.join("\n");
      expect(logText).not.toContain("sensitive-user-token-abc");
    } finally {
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }
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
          async resolveCollaborationScope() {
            return { kind: "forbidden" };
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

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode(payload)}.fixture-signature`;
}

const ADMIN_EXP = Math.floor(Date.now() / 1000) + 600;

function userWithClaims(raw: Record<string, unknown>): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { ...testUser, raw });
    await next();
  };
}

type CollaborationResult = Awaited<ReturnType<WorkspaceScopeModule["resolveCollaborationScope"]>>;

function collaborationApp(options: {
  raw: Record<string, unknown>;
  result?: CollaborationResult;
  issued?: Record<string, unknown>;
}) {
  const resolveCalls: unknown[] = [];
  const switchCalls: unknown[] = [];
  const adapterCalls: Array<{ subjectToken: string; scope: SurrealTokenScope }> = [];
  const app = createApp({
    requireUser: () => userWithClaims(options.raw),
    idpTokenScopeAdapter: {
      async updateUserScope(input) {
        adapterCalls.push(input);
        return {
          accessToken: unsignedJwt(
            options.issued ?? { sub: "user-123", db: input.scope.db, ac: input.scope.ac, exp: ADMIN_EXP },
          ),
          expiresIn: 300,
        };
      },
    },
    workspaceScope: {
      async getDefaultScope() {
        return { kind: "login-denied", reason: "no-workspace" };
      },
      async listWorkspaces() {
        return { workspaces: [], canCreate: false };
      },
      async switchWorkspace(input) {
        switchCalls.push(input);
        return { kind: "switched", scope: { db: "ws_recent", ac: "admin" } };
      },
      async resolveCollaborationScope(input) {
        resolveCalls.push(input);
        return options.result ?? { kind: "participant", scope: { db: "ws_recent", ac: "participant" } };
      },
    },
  });
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { post, resolveCalls, switchCalls, adapterCalls };
}

const ADMIN_RAW = { ac: "admin", db: "ws_recent", exp: ADMIN_EXP, RL: ["Owner"] };

describe("session collaboration scope", () => {
  test("downgrades a workspace admin to a same-subject participant token for the selected workspace", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW });

    const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, expiresIn: 300 });
    expect(harness.resolveCalls).toEqual([{ subject: "user-123", workspaceSlug: "recent" }]);
    expect(harness.adapterCalls).toEqual([
      { subjectToken: "test-token", scope: { db: "ws_recent", ac: "participant" } },
    ]);
    expect(harness.switchCalls).toEqual([]);
  });

  test("accepts dbName target with the same shape as switch-workspace", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW });

    const response = await harness.post("/api/session/collaboration-scope", { dbName: "ws_recent" });

    expect(response.status).toBe(200);
    expect(harness.resolveCalls).toEqual([{ subject: "user-123", dbName: "ws_recent" }]);
  });

  test("rejects requests for any access other than participant without exchanging", async () => {
    for (const raw of [ADMIN_RAW, { ...ADMIN_RAW, ac: "participant", RL: ["Editor"] }]) {
      for (const ac of ["admin", "owner", null]) {
        const harness = collaborationApp({ raw });
        const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent", ac });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "collaboration-scope-access-invalid" } });
        expect(harness.resolveCalls).toEqual([]);
        expect(harness.adapterCalls).toEqual([]);
      }
    }
  });

  test("a participant token can only ever receive participant scope", async () => {
    const harness = collaborationApp({ raw: { ...ADMIN_RAW, ac: "participant", RL: ["Editor"] } });

    const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });

    expect(response.status).toBe(200);
    expect(harness.adapterCalls.map((call) => call.scope.ac)).toEqual(["participant"]);
  });

  test("returns 409 when no live human user row matches the subject", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW, result: { kind: "member-missing" } });

    const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "collaboration-member-missing" } });
    expect(harness.adapterCalls).toEqual([]);
  });

  test("returns 403 for inaccessible workspaces", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW, result: { kind: "forbidden" } });

    const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });

    expect(response.status).toBe(403);
    expect(harness.adapterCalls).toEqual([]);
  });

  test("refuses to exchange for a workspace other than the token's current db", async () => {
    for (const raw of [
      { ...ADMIN_RAW, db: "ws_other" },
      { ...ADMIN_RAW, db: undefined },
      { ...ADMIN_RAW, ac: "content_reader" },
      { ...ADMIN_RAW, ac: undefined },
    ]) {
      const harness = collaborationApp({ raw });
      const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "collaboration-scope-workspace-not-selected" } });
      expect(harness.adapterCalls).toEqual([]);
    }
  });

  test("requires a workspace target", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW });

    const response = await harness.post("/api/session/collaboration-scope", {});

    expect(response.status).toBe(400);
    expect(harness.resolveCalls).toEqual([]);
  });

  test("rejects IdP tokens that extend expiry or change sub/db/ac", async () => {
    for (const issued of [
      { sub: "user-123", db: "ws_recent", ac: "participant", exp: ADMIN_EXP + 1 },
      { sub: "someone-else", db: "ws_recent", ac: "participant", exp: ADMIN_EXP },
      { sub: "user-123", db: "ws_other", ac: "participant", exp: ADMIN_EXP },
      { sub: "user-123", db: "ws_recent", ac: "admin", exp: ADMIN_EXP },
      { sub: "user-123", db: "ws_recent", ac: "participant" },
    ]) {
      const harness = collaborationApp({ raw: ADMIN_RAW, issued });
      const response = await harness.post("/api/session/collaboration-scope", { workspaceSlug: "recent" });
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain("fixture-signature");
    }
  });

  test("default switch-workspace for admins still issues ac=admin", async () => {
    const harness = collaborationApp({ raw: ADMIN_RAW });

    const response = await harness.post("/api/session/switch-workspace", { workspaceSlug: "recent" });

    expect(response.status).toBe(200);
    expect(harness.adapterCalls).toEqual([
      { subjectToken: "test-token", scope: { db: "ws_recent", ac: "admin" } },
    ]);
    expect(harness.resolveCalls).toEqual([]);
  });
});
