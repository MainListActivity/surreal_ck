import { describe, expect, test, spyOn } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import { createEmployeeRuntime } from "../../ai/office/employee-runtime";
import type { Surreal } from "surrealdb";
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

type TriggerCall = {
  database: string;
  employeeId: string;
  reason: string;
  payloadRef?: string;
  chainDepth: number;
  idempotencyKey: string;
};

function stubTriggerRuntime(outcome: "completed" | "coalesced" | "waiting" | "failed" = "completed") {
  const calls: TriggerCall[] = [];
  const result =
    outcome === "failed"
      ? { outcome, error: "employee-signin-failed" as string }
      : { outcome, triggerId: "employee_trigger:probe1" };
  return {
    calls,
    runtime: {
      start() {},
      registerHandler() {},
      async enqueue(delivery: TriggerCall) {
        calls.push(delivery);
        return result;
      },
    },
  };
}

function appWith(lifecycle: EmployeeLifecycle, user = adminUser) {
  return createApp({
    employeeLifecycle: lifecycle,
    employeeTriggerRuntime: stubTriggerRuntime().runtime,
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

  test("roleKey 接受既有连字符岗位 key（project-manager），非法格式仍 400", async () => {
    const { lifecycle, calls } = stubLifecycle({ kind: "ok", employee: okEmployee, created: true });
    const app = appWith(lifecycle);
    const ok = await app.fetch(
      post("/api/workspaces/acme/employees", { requestKey: "req-key-0001", roleKey: "project-manager" }),
    );
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ action: "provision", slug: "acme" }]);
    expect(
      (await app.fetch(post("/api/workspaces/acme/employees", { requestKey: "req-key-0001", roleKey: "-bad" }))).status,
    ).toBe(400);
    expect(
      (await app.fetch(post("/api/workspaces/acme/employees", { requestKey: "req-key-0001", roleKey: "has space" }))).status,
    ).toBe(400);
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


describe("GET controlled employee runtime observation", () => {
  const path = "http://localhost/api/internal/workspaces/acme/employees/ve_ab12/runtime";
  test("无凭证 401；participant/跨库/缺 scope 403，均不触发探测", async () => {
    const { lifecycle } = stubLifecycle({ kind: "ok", employee: okEmployee, created: false });
    let probes = 0;
    const employeeRuntime = { inspect: async () => { probes++; throw new Error("should-not-probe"); } };
    const options = { employeeLifecycle: lifecycle, employeeRuntime,
      employeeWorkspaceResolver: async () => ({ dbName: "ws_acme" }) };
    expect((await createApp(options).fetch(new Request(path))).status).toBe(401);
    for (const user of [participantUser, foreignUser, { ...adminUser, raw: {} }]) {
      expect((await createApp({ ...options, requireUser: () => useUser(user) }).fetch(new Request(path))).status).toBe(403);
    }
    expect(probes).toBe(0);
  });

  test("admin 读取注入的同一 runtime；白名单响应/no-store；异常与日志去敏", async () => {
    const marker = "SYNTHETIC_SECRET_TOKEN_ROOT_PAYLOAD";
    const logs: unknown[] = [];
    const info = spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    const error = spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
    try {
      const runtime = createEmployeeRuntime({ surrealUrl: "wss://example.test", namespace: "main", connect: () => ({
        async connect() {}, async signin() {}, async close() {},
        async auth() { return { id: "user:ve_ab12", virtual_profile: { status: "active" }, secret: marker, token: marker }; },
      } as unknown as Surreal) });
      await runtime.register({ database: "ws_acme", employeeId: "user:ve_ab12", subject: marker, secret: marker });
      const options = { employeeLifecycle: stubLifecycle({ kind: "ok", employee: okEmployee, created: false }).lifecycle,
        employeeWorkspaceResolver: async () => ({ dbName: "ws_acme" }), requireUser: () => useUser(adminUser), employeeRuntime: runtime };
      const app = createApp(options);
      const response = await app.fetch(new Request(path + "?sql=" + encodeURIComponent(marker)));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({ database: "ws_acme", employeeId: "user:ve_ab12", usable: true, generation: 1 });
      expect(Object.keys(body).sort()).toEqual(["database", "employeeId", "instanceId", "sampledAt", "sessionPresent", "connectionCount", "usable", "generation", "lastRegisteredAt", "lastClosedAt", "closeConfirmed", "probeCode"].sort());
      expect(JSON.stringify(body)).not.toContain(marker);
      await runtime.close("ws_acme", "user:ve_ab12");
      expect(await (await app.fetch(new Request(path))).json()).toMatchObject({ usable: false, closeConfirmed: true });
      expect((await app.fetch(new Request(path.replace("ve_ab12", "bad-key")))).status).toBe(400);
      const failed = createApp({ ...options, employeeRuntime: { inspect: async () => { throw new Error(marker); } } });
      const failure = await failed.fetch(new Request(path));
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain(marker);
      expect(JSON.stringify(logs)).not.toContain(marker);
      await runtime.stop();
    } finally { info.mockRestore(); error.mockRestore(); }
  });
});

describe("POST /api/internal/workspaces/:slug/employees/:employeeKey/triggers (qa-probe)", () => {
  const path = "/api/internal/workspaces/acme/employees/ve_ab12/triggers";

  function probeApp(result: Parameters<typeof stubTriggerRuntime>[0] = "completed", user = adminUser) {
    const stub = stubTriggerRuntime(result);
    const app = createApp({
      employeeLifecycle: stubLifecycle({ kind: "ok", employee: okEmployee, created: false }).lifecycle,
      employeeTriggerRuntime: stub.runtime,
      employeeWorkspaceResolver: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
      requireUser: () => useUser(user),
    });
    return { app, calls: stub.calls };
  }

  test("无凭证 401；participant/跨库/缺 scope 403 且不投递", async () => {
    const { app, calls } = probeApp();
    expect((await app.fetch(post("/api/internal/workspaces/acme/employees/ve_ab12/triggers", { idempotencyKey: "qa-probe-0001" }))).status).toBe(200);
    for (const user of [participantUser, foreignUser, { ...adminUser, raw: {} }]) {
      const blocked = probeApp("completed", user);
      expect((await blocked.app.fetch(post(path, { idempotencyKey: "qa-probe-0002" }))).status).toBe(403);
      expect(blocked.calls).toHaveLength(0);
    }
    expect(calls).toHaveLength(1);
  });

  test("admin + 合法体 → 200，投递参数正确且响应只有终态摘要", async () => {
    const { app, calls } = probeApp("completed");
    const res = await app.fetch(post(path, {
      idempotencyKey: "qa-probe-0003",
      payloadRef: "office_meta:office",
      chainDepth: 1,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: true, outcome: "completed", triggerId: "employee_trigger:probe1" });
    expect(calls).toEqual([{
      database: "ws_acme",
      employeeId: "user:ve_ab12",
      reason: "qa-probe",
      payloadRef: "office_meta:office",
      chainDepth: 1,
      idempotencyKey: "qa-probe-0003",
    }]);
  });

  test("缺省 reason 即 qa-probe；其他 reason / 非法字段 → 400 不投递", async () => {
    const { app, calls } = probeApp();
    for (const body of [
      { idempotencyKey: "qa-probe-ok", reason: "daily-claims-risk" },
      { idempotencyKey: "qa-probe-ok", reason: "office-bootstrap" },
      { idempotencyKey: "short" },
      { idempotencyKey: "has space in key!!" },
      {},
      { idempotencyKey: "qa-probe-ok", chainDepth: -1 },
      { idempotencyKey: "qa-probe-ok", chainDepth: 1.5 },
      { idempotencyKey: "qa-probe-ok", chainDepth: "0" },
      { idempotencyKey: "qa-probe-ok", payloadRef: 42 },
      { idempotencyKey: "qa-probe-ok", payloadRef: "x".repeat(201) },
    ]) {
      expect((await app.fetch(post(path, body))).status).toBe(400);
    }
    // 缺省 reason 与合法 chainDepth/payloadRef 通过。
    expect((await app.fetch(post(path, { idempotencyKey: "qa-probe-ok9" }))).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: "qa-probe", chainDepth: 0 });
    expect(calls[0]).not.toHaveProperty("payloadRef");
  });

  test("employeeKey 格式非法 → 400；waiting/coalesced/failed 均 200 透传 outcome", async () => {
    const { app } = probeApp();
    expect((await app.fetch(post(path.replace("ve_ab12", "9bad"), { idempotencyKey: "qa-probe-0004" }))).status).toBe(400);
    expect((await app.fetch(post(path.replace("ve_ab12", "bad%40key"), { idempotencyKey: "qa-probe-0005" }))).status).toBe(400);

    for (const outcome of ["waiting", "coalesced", "failed"] as const) {
      const probe = probeApp(outcome);
      const res = await probe.app.fetch(post(path, { idempotencyKey: `qa-probe-${outcome}` }));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.outcome).toBe(outcome);
      if (outcome === "failed") expect(body.error).toBe("employee-signin-failed");
    }
  });

  test("响应不泄漏内部对象/凭证/堆栈", async () => {
    const { app } = probeApp("completed");
    const res = await app.fetch(post(path, { idempotencyKey: "qa-probe-leak" }));
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
    expect(text).not.toContain("Surreal");
    expect(text).not.toContain("stack");
  });
});
