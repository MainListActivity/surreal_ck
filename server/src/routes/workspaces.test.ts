import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { CreateWorkspaceInput, CreateWorkspaceResult, WorkspaceCreator } from "../workspaces/create-workspace";

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

describe("POST /api/workspaces", () => {
  test("requires OIDC before creating a workspace", async () => {
    const { creator, calls } = stubCreator(() => ({
      kind: "created",
      slug: "acme",
      dbName: "ws_x",
      refreshRequired: true,
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

  test("creates a workspace from the caller's OIDC identity and returns refresh-required", async () => {
    const { creator, calls } = stubCreator((input) => ({
      kind: "created",
      slug: input.slug,
      dbName: "ws_abcdef123456",
      refreshRequired: true,
    }));

    const app = createApp({ requireUser: () => useTestUser, workspaceCreator: creator });

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
      refreshRequired: true,
    });
    expect(calls).toEqual([
      { subject: "user-123", email: "ada@example.test", name: "Acme Legal", slug: "acme" },
    ]);
  });

  test("returns 409 when the slug already exists", async () => {
    const { creator } = stubCreator(() => ({ kind: "slug-conflict" }));
    const app = createApp({ requireUser: () => useTestUser, workspaceCreator: creator });

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
    const app = createApp({ requireUser: () => useTestUser, workspaceCreator: creator });

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
