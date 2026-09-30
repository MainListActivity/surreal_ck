import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { EmployeeLifecycle, EmployeeLifecycleResult } from "../../ai/office/employee-lifecycle";

/** 路由层测试：scope 校验、请求体校验、结果→状态码映射、响应不泄漏凭证。 */

const adminUser = {
  subject: "admin-sub",
  email: "admin@example.test",
  raw: { db: "ws_acme", ac: "admin" },
  rawToken: "admin-token",
};

const participantUser = {
  subject: "member-sub",
  email: "member@example.test",
  raw: { db: "ws_acme", ac: "participant" },
  rawToken: "member-token",
};

const foreignUser = {
  subject: "admin-sub",
  email: "admin@example.test",
  raw: { db: "ws_other", ac: "admin" },
  rawToken: "foreign-token",
};

const useUser = (user: typeof adminUser): MiddlewareHandler<AppBindings> => async (c, next) => {
  c.set("user", user);
  await next();
};

const okEmployee = {
  id: "user:ve_ab12",
  subject: "ve-ab12",
  displayName: "虚拟员工",
  roleKey: null,
  status: "active" as const,
};

function stubLifecycle(result: EmployeeLifecycleResult): {
  lifecycle: EmployeeLifecycle;
  calls: Array<{ action: string; slug: string; employeeId?: string }>;
} {
  const calls: Array<{ action: string; slug: string; employeeId?: string }> = [];
  return {
    calls,
    lifecycle: {
      provision: async (input) => {
        calls.push({ action: "provision", slug: input.slug });
        return result;
      },
      pause: async (slug, employeeId) => {
        calls.push({ action: "pause", slug, employeeId });
        return result;
      },
      resume: async (slug, employeeId) => {
        calls.push({ action: "resume", slug, employeeId });
        return result;
      },
      retire: async (slug, employeeId) => {
        calls.push({ action: "retire", slug, employeeId });
        return result;
      },
    } as unknown as EmployeeLifecycle,
  };
}

function appWith(lifecycle: EmployeeLifecycle, user = adminUser) {
  return createApp({
    employeeLifecycle: lifecycle,
    employeeWorkspaceResolver: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
    requireUser: () => useUser(user),
  });
}

const post = (path: string, body?: unknown, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });

describe("POST /api/workspaces/:slug/employees", () => {
  test("admin token + 合法 requestKey → 200 与员工视图（不含 secret）", async () => {
    const { lifecycle, calls } = stubLifecycle({ kind: "ok", employee: okEmployee, created: true });
    const app = appWith(lifecycle);
    const res = await app.fetch(post("/api/workspaces/acme/employees", { requestKey: "req-key-0001" }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(calls).toEqual([{ action: "provision", slug: "acme" }]);
  });

  test("缺/坏 requestKey → 400", async () => {
    const { lifecycle } = stubLifecycle({ kind: "ok", employee: okEmployee, created: true });
    const app = appWith(lifecycle);
    expect((await app.fetch(post("/api/workspaces/acme/employees", {}))).status).toBe(400);
    expect((await app.fetch(post("/api/workspaces/acme/employees", { requestKey: "x" }))).status).toBe(400);
    expect((await app.fetch(post("/api/workspaces/acme/employees", { requestKey: "has space in key" }))).status).toBe(400);
  });

  test("participant token / 其它 workspace token / 缺 db claim → 403 且不进 lifecycle", async () => {
    const { lifecycle, calls } = stubLifecycle({ kind: "ok", employee: okEmployee, created: true });
    for (const user of [participantUser, foreignUser, { ...adminUser, raw: {} }]) {
      const res = await appWith(lifecycle, user).fetch(
        post("/api/workspaces/acme/employees", { requestKey: "req-key-0001" }),
      );
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test("未知 workspace slug → 404", async () => {
    const { lifecycle } = stubLifecycle({ kind: "ok", employee: okEmployee, created: true });
    const res = await appWith(lifecycle).fetch(post("/api/workspaces/ghost/employees", { requestKey: "req-key-0001" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workspaces/:slug/employees/:key/:action", () => {
  test("pause/resume/retire 透传并映射结果", async () => {
    const { lifecycle, calls } = stubLifecycle({ kind: "ok", employee: { ...okEmployee, status: "paused" }, created: false });
    const app = appWith(lifecycle);
    const res = await app.fetch(post("/api/workspaces/acme/employees/ve_ab12/pause"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ action: "pause", slug: "acme", employeeId: "ve_ab12" }]);
  });

  test("retire 返回 credentialsExpireBy；invalid-transition → 409；employee-not-found → 404", async () => {
    const { lifecycle } = stubLifecycle({
      kind: "ok",
      employee: { ...okEmployee, status: "retired" },
      created: false,
      credentialsExpireBy: "2026-09-30T01:00:00.000Z",
    });
    const res = await appWith(lifecycle).fetch(post("/api/workspaces/acme/employees/ve_ab12/retire"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.credentialsExpireBy).toBe("2026-09-30T01:00:00.000Z");

    const conflict = appWith(stubLifecycle({ kind: "invalid-transition", status: "retired" }).lifecycle);
    expect((await conflict.fetch(post("/api/workspaces/acme/employees/ve_ab12/resume"))).status).toBe(409);
    const missing = appWith(stubLifecycle({ kind: "employee-not-found" }).lifecycle);
    expect((await missing.fetch(post("/api/workspaces/acme/employees/ve_ab12/pause"))).status).toBe(404);
  });

  test("participant token 对员工状态操作同样 403", async () => {
    const { lifecycle, calls } = stubLifecycle({ kind: "ok", employee: okEmployee, created: false });
    const res = await appWith(lifecycle, participantUser).fetch(
      post("/api/workspaces/acme/employees/ve_ab12/pause"),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
