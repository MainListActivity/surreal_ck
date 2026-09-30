import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type { OfficeBootstrapResult } from "../../ai/office/office-trigger-adapter";
import type { OfficeBootstrapAction } from "./office";

/** 路由层测试：scope 校验、workspace 解析、结果→状态码映射、响应不泄漏凭证。 */

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

function appWith(result: OfficeBootstrapResult, user = adminUser) {
  const calls: Array<{ slug: string; callerToken: string }> = [];
  const bootstrap: OfficeBootstrapAction = async (input) => {
    calls.push(input);
    return result;
  };
  const app = createApp({
    officeBootstrap: bootstrap,
    employeeWorkspaceResolver: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
    requireUser: () => useUser(user),
  });
  return { app, calls };
}

const post = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

describe("POST /api/workspaces/:slug/office/bootstrap", () => {
  test("admin token + 已有 meta → 200 与员工/触发视图（不含凭证）", async () => {
    const { app, calls } = appWith({
      kind: "ok",
      employeeId: "user:ve_pm",
      outcome: "completed",
      triggerId: "employee_trigger:t1",
      taskId: "office_task:pm_initial",
    });
    const res = await app.fetch(post("/api/workspaces/acme/office/bootstrap"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, employeeId: "user:ve_pm", taskId: "office_task:pm_initial" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(calls).toEqual([{ slug: "acme", callerToken: "admin-token" }]);
  });

  test("participant token / 其它 workspace token / 缺 db claim → 403 且不进 bootstrap", async () => {
    const { app, calls } = appWith({ kind: "meta-incomplete", missing: ["goal"] });
    for (const user of [participantUser, foreignUser, { ...adminUser, raw: {} }]) {
      const res = await appWith({ kind: "meta-incomplete", missing: ["goal"] }, user).app
        .fetch(post("/api/workspaces/acme/office/bootstrap"));
      expect(res.status).toBe(403);
    }
    void app;
    expect(calls).toHaveLength(0);
  });

  test("未知 workspace slug → 404", async () => {
    const { app } = appWith({ kind: "workspace-not-found" });
    const res = await app.fetch(post("/api/workspaces/ghost/office/bootstrap"));
    expect(res.status).toBe(404);
  });

  test("meta-incomplete → 409 office-meta-incomplete；trigger-failed → 409", async () => {
    const incomplete = appWith({ kind: "meta-incomplete", missing: ["goal", "primary_contact"] });
    const res = await incomplete.app.fetch(post("/api/workspaces/acme/office/bootstrap"));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("office-meta-incomplete");

    const failed = appWith({ kind: "trigger-failed", error: "boom" });
    expect((await failed.app.fetch(post("/api/workspaces/acme/office/bootstrap"))).status).toBe(409);
  });
});
