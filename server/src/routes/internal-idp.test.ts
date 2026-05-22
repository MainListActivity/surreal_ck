import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import type { WorkspaceScopeModule } from "../workspaces/workspace-scope";

function createWorkspaceScopeStub(result: Awaited<ReturnType<WorkspaceScopeModule["getDefaultScope"]>>): WorkspaceScopeModule {
  return {
    async getDefaultScope() {
      return result;
    },
    async listWorkspaces() {
      return [];
    },
    async switchWorkspace() {
      return { kind: "forbidden" };
    },
  };
}

describe("IdP default scope hook", () => {
  test("returns a SurrealDB token scope for an existing workspace member", async () => {
    const app = createApp({
      workspaceScope: createWorkspaceScopeStub({
        kind: "scope",
        scope: { db: "ws_recent", ac: "admin" },
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/internal/idp/default-scope?subject=user-123", {
        headers: { authorization: "Bearer test-hook-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ db: "ws_recent", ac: "admin" });
  });

  test("returns login-denied when the subject has no active workspace", async () => {
    const app = createApp({
      workspaceScope: createWorkspaceScopeStub({
        kind: "login-denied",
        reason: "no-workspace",
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/internal/idp/default-scope?subject=user-404", {
        headers: { authorization: "Bearer test-hook-secret" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "login-denied" },
    });
  });
});
