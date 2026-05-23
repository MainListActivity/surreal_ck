import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type {
  AddMemberInput,
  AddMemberResult,
  MemberManager,
  RemoveMemberInput,
  RemoveMemberResult,
  UpdateMemberRoleInput,
  UpdateMemberRoleResult,
} from "../workspaces/member-manager";

const testUser = {
  subject: "admin-sub",
  email: "admin@example.test",
  raw: {},
  rawToken: "test-token",
};

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", testUser);
  await next();
};

type StubCalls = {
  add: AddMemberInput[];
  update: UpdateMemberRoleInput[];
  remove: RemoveMemberInput[];
};

function stubManager(handlers: {
  add?: (input: AddMemberInput) => AddMemberResult;
  update?: (input: UpdateMemberRoleInput) => UpdateMemberRoleResult;
  remove?: (input: RemoveMemberInput) => RemoveMemberResult;
}): { manager: MemberManager; calls: StubCalls } {
  const calls: StubCalls = { add: [], update: [], remove: [] };
  return {
    calls,
    manager: {
      async addMember(input) {
        calls.add.push(input);
        return handlers.add?.(input) ?? { kind: "added" };
      },
      async updateMemberRole(input) {
        calls.update.push(input);
        return handlers.update?.(input) ?? { kind: "updated" };
      },
      async removeMember(input) {
        calls.remove.push(input);
        return handlers.remove?.(input) ?? { kind: "removed" };
      },
    },
  };
}

function appWith(manager: MemberManager, requireUser = () => useTestUser) {
  return createApp({ memberManager: manager, requireUser });
}

describe("POST /api/workspaces/:slug/members", () => {
  test("requires OIDC", async () => {
    const { manager, calls } = stubManager({});
    const app = createApp({ memberManager: manager });

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "newbie@example.test" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(calls.add).toEqual([]);
  });

  test("pre-creates a member from the caller's OIDC subject and the slug", async () => {
    const { manager, calls } = stubManager({});
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Newbie@Example.test", displayName: "New Bie", isAdmin: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.add).toEqual([
      { callerSubject: "admin-sub", slug: "acme", email: "newbie@example.test", displayName: "New Bie", isAdmin: true },
    ]);
  });

  test("rejects a missing or invalid email with 400 before touching the manager", async () => {
    const { manager, calls } = stubManager({});
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "No Email" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "member-email-invalid" } });
    expect(calls.add).toEqual([]);
  });

  test("maps forbidden to 403", async () => {
    const { manager } = stubManager({ add: () => ({ kind: "forbidden" }) });
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "newbie@example.test" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "member-admin-forbidden" } });
  });

  test("maps workspace-not-found to 404", async () => {
    const { manager } = stubManager({ add: () => ({ kind: "workspace-not-found" }) });
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/ghost/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "newbie@example.test" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "workspace-not-found" } });
  });
});

describe("PATCH /api/workspaces/:slug/members/:userId", () => {
  test("updates a member's role from isAdmin", async () => {
    const { manager, calls } = stubManager({});
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members/member-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isAdmin: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.update).toEqual([
      { callerSubject: "admin-sub", slug: "acme", userId: "member-id", isAdmin: true },
    ]);
  });

  test("rejects a non-boolean isAdmin with 400", async () => {
    const { manager, calls } = stubManager({});
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members/member-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "member-role-invalid" } });
    expect(calls.update).toEqual([]);
  });

  test("maps member-not-found to 404", async () => {
    const { manager } = stubManager({ update: () => ({ kind: "member-not-found" }) });
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members/ghost", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isAdmin: false }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "member-not-found" } });
  });
});

describe("DELETE /api/workspaces/:slug/members/:userId", () => {
  test("soft-removes a member", async () => {
    const { manager, calls } = stubManager({});
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members/member-id", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.remove).toEqual([{ callerSubject: "admin-sub", slug: "acme", userId: "member-id" }]);
  });

  test("maps forbidden to 403", async () => {
    const { manager } = stubManager({ remove: () => ({ kind: "forbidden" }) });
    const app = appWith(manager);

    const response = await app.fetch(
      new Request("http://localhost/api/workspaces/acme/members/member-id", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "member-admin-forbidden" } });
  });
});
