import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { CreateWorkspaceInput, CreateWorkspaceResult, WorkspaceCreator } from "../workspaces/create-workspace";
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

function stubCreator(
  handler: (input: CreateWorkspaceInput) => CreateWorkspaceResult,
): { creator: WorkspaceCreator; calls: CreateWorkspaceInput[] } {
  const calls: CreateWorkspaceInput[] = [];
  return {
    calls,
    creator: {
      async createWorkspace(input) {
        calls.push(input);
        return handler(input);
      },
    },
  };
}

function stubWorkspaceScope(canCreate: boolean): WorkspaceScopeModule {
  return {
    async getDefaultScope() {
      return { kind: "login-denied", reason: "no-workspace" };
    },
    async listWorkspaces() {
      return { workspaces: [], canCreate };
    },
    async switchWorkspace() {
      return { kind: "forbidden" };
    },
  };
}

describe("POST /api/workspaces", () => {
  test("requires OIDC before creating a workspace", async () => {
    const { creator, calls } = stubCreator(() => ({
      kind: "created",
      slug: "acme",
      dbName: "ws_x",
      accessToken: "scoped-token",
      expiresIn: 3600,
    }));

    const app = createApp({ workspaceCreator: creator });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "oidc-missing" } });
    expect(calls).toEqual([]);
  });

  test("rejects callers when system_admin is empty before provisioning", async () => {
    const { creator, calls } = stubCreator(() => ({
      kind: "created",
      slug: "acme",
      dbName: "ws_x",
      accessToken: "scoped-token",
      expiresIn: 3600,
    }));
    const app = createApp({
      requireUser: () => useTestUser,
      workspaceCreator: creator,
      workspaceScope: stubWorkspaceScope(false),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "workspace-create-forbidden" } });
    expect(calls).toEqual([]);
  });

  test("creates a workspace without a token grant when system_admin has data", async () => {
    const { creator, calls } = stubCreator((input) => ({
      kind: "created",
      slug: input.slug,
      dbName: "ws_abcdef123456",
      accessToken: "scoped-token",
      expiresIn: 3600,
    }));

    const app = createApp({
      requireUser: () => useTestUser,
      workspaceCreator: creator,
      workspaceScope: stubWorkspaceScope(true),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme Legal", slug: "Acme" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "acme",
      dbName: "ws_abcdef123456",
      accessToken: "scoped-token",
      expiresIn: 3600,
    });
    expect(calls).toEqual([
      {
        subject: "user-123",
        subjectToken: "test-token",
        email: "ada@example.test",
        name: "Acme Legal",
        slug: "acme",
      },
    ]);
  });

  test("returns 409 when the slug already exists", async () => {
    const { creator } = stubCreator(() => ({ kind: "slug-conflict" }));
    const app = createApp({
      requireUser: () => useTestUser,
      workspaceCreator: creator,
      workspaceScope: stubWorkspaceScope(true),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workspace-slug-conflict" } });
  });

  test("returns 502 scope-update-failed when the workspace exists but token scope update failed", async () => {
    const { creator } = stubCreator(() => ({
      kind: "scope-update-failed",
      slug: "acme",
      dbName: "ws_abcdef123456",
    }));
    const app = createApp({
      requireUser: () => useTestUser,
      workspaceCreator: creator,
      workspaceScope: stubWorkspaceScope(true),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "scope-update-failed" } });
  });
});
