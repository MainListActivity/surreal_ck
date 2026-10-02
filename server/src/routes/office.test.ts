import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type {
  OfficeBootstrapResult,
  OfficeRequestWakeResult,
  OfficeTaskDispatchResult,
} from "../../ai/office/office-trigger-adapter";
import type { OfficeBootstrapAction, OfficeRequestWakeAction } from "./office";

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

describe("POST /api/workspaces/:slug/office/requests/:notificationId/wake", () => {
  const WAKE_PATH = "/api/workspaces/acme/office/requests/user_notification%3Aofreq_t1_x/wake";

  function wakeApp(result: OfficeRequestWakeResult, user = participantUser) {
    const calls: Array<{ slug: string; callerToken: string; notificationId: string }> = [];
    const wakeRequest: OfficeRequestWakeAction = async (input) => {
      calls.push(input);
      return result;
    };
    const app = createApp({
      officeBootstrap: async () => ({ kind: "meta-incomplete", missing: [] }),
      officeRequestWake: wakeRequest,
      employeeWorkspaceResolver: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
      requireUser: () => useUser(user),
    });
    return { app, calls };
  }

  test("收件人 token → 200 并透传通知 id 与触发终态", async () => {
    const { app, calls } = wakeApp({ kind: "ok", outcome: "completed", triggerId: "employee_trigger:w1" });
    const res = await app.fetch(post(WAKE_PATH));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, outcome: "completed", triggerId: "employee_trigger:w1" });
    expect(calls).toEqual([{
      slug: "acme",
      callerToken: "member-token",
      notificationId: "user_notification:ofreq_t1_x",
    }]);
  });

  test("其它 workspace token / 缺 db claim → 403 且不进 wake 动作", async () => {
    for (const user of [foreignUser, { ...adminUser, raw: {} }]) {
      const { app, calls } = wakeApp({ kind: "ok", outcome: "completed", triggerId: "t" }, user);
      const res = await app.fetch(post(WAKE_PATH));
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  test("未知 workspace → 404；未落终态 → 409；通知不可见 → 404", async () => {
    const ghost = wakeApp({ kind: "ok", outcome: "completed", triggerId: "t" });
    expect((await ghost.app.fetch(post("/api/workspaces/ghost/office/requests/x/wake"))).status).toBe(404);

    const unresolved = wakeApp({ kind: "unresolved" });
    const res = await unresolved.app.fetch(post(WAKE_PATH));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("office-request-unresolved");

    const missing = wakeApp({ kind: "not-found" });
    expect((await missing.app.fetch(post(WAKE_PATH))).status).toBe(404);
  });

  test("非请求通知 / 投递失败 → 409；响应不携带凭证", async () => {
    const notRequest = wakeApp({ kind: "not-request" });
    const res1 = await notRequest.app.fetch(post(WAKE_PATH));
    expect(res1.status).toBe(409);
    expect(JSON.stringify(await res1.json())).not.toContain("token");

    const failed = wakeApp({ kind: "trigger-failed", error: "lane-full" });
    expect((await failed.app.fetch(post(WAKE_PATH))).status).toBe(409);
  });
});

describe("POST /api/workspaces/:slug/office/tasks/:taskId/dispatch（VO06）", () => {
  const DISPATCH_PATH = "/api/workspaces/acme/office/tasks/office_task:utask_x/dispatch";

  function dispatchApp(
    result: OfficeTaskDispatchResult,
    user = adminUser,
    withDispatch = true,
  ) {
    const calls: Array<{ slug: string; callerToken: string; taskId: string }> = [];
    const app = createApp({
      officeBootstrap: async () => ({ kind: "meta-incomplete", missing: [] }),
      ...(withDispatch
        ? {
            officeTaskDispatch: async (input: { slug: string; callerToken: string; taskId: string }) => {
              calls.push(input);
              return result;
            },
          }
        : {}),
      employeeWorkspaceResolver: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
      requireUser: () => useUser(user),
    });
    return { app, calls };
  }

  test("admin token → 200 并透传 taskId 与触发终态", async () => {
    const { app, calls } = dispatchApp({ kind: "ok", outcome: "completed", triggerId: "employee_trigger:d1" });
    const res = await app.fetch(post(DISPATCH_PATH));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, outcome: "completed", triggerId: "employee_trigger:d1" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(calls).toEqual([
      { slug: "acme", callerToken: "admin-token", taskId: "office_task:utask_x" },
    ]);
  });

  test("participant / 其它 workspace token → 403 且不进 dispatch 动作", async () => {
    for (const user of [participantUser, foreignUser]) {
      const { app, calls } = dispatchApp({ kind: "ok", outcome: "completed", triggerId: "t" }, user);
      const res = await app.fetch(post(DISPATCH_PATH));
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  test("未知 workspace → 404；未接线 → 501；任务不存在 → 404", async () => {
    const ghost = dispatchApp({ kind: "ok", outcome: "completed", triggerId: "t" });
    expect(
      (await ghost.app.fetch(post("/api/workspaces/ghost/office/tasks/office_task:x/dispatch"))).status,
    ).toBe(404);

    // 未接线（createOfficeRoutes 未注入 dispatchTask，绕开 app.ts 兜底）→ 501。
    const { createOfficeRoutes } = await import("./office");
    const { handleError } = await import("../middleware/error");
    const bare = createOfficeRoutes({
      bootstrap: async () => ({ kind: "meta-incomplete", missing: [] }),
      resolveWorkspace: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
      requireUser: () => useUser(adminUser),
    }).onError(handleError);
    expect((await bare.fetch(post(DISPATCH_PATH))).status).toBe(501);

    const missing = dispatchApp({ kind: "task-not-found" });
    expect((await missing.app.fetch(post(DISPATCH_PATH))).status).toBe(404);
  });

  test("终态任务 / 真人 assignee / 未激活员工 / 投递失败 → 409", async () => {
    for (const result of [
      { kind: "task-terminal", status: "done" },
      { kind: "assignee-not-virtual" },
      { kind: "assignee-inactive", status: "paused" },
      { kind: "trigger-failed", error: "lane-full" },
    ] as OfficeTaskDispatchResult[]) {
      const { app } = dispatchApp(result);
      expect((await app.fetch(post(DISPATCH_PATH))).status).toBe(409);
    }
  });
});
