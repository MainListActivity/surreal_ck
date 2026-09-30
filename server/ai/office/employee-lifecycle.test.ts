import { describe, expect, test } from "bun:test";
import { createEmployeeLifecycle, type EmployeeLifecycleDeps } from "./employee-lifecycle";
import type { EmployeeRuntime, EmployeeSessionTarget } from "./employee-runtime";

/**
 * 生命周期单元测试：用内存假会话模拟 user / employee_credential / office_role
 * 三表与唯一索引约束，覆盖重复请求、并发请求、部分失败与状态机。
 */

type Row = Record<string, unknown>;

type FakeDb = {
  users: Map<string, Row>;
  credentials: Map<string, Row>;
  roles: Map<string, Row>;
  queries: string[];
  failCredentialWrites: number;
};

function recordIdString(value: unknown): string {
  return String(value);
}

/** 按 SQL 形态分发的最小查询假实现，忠实模拟唯一索引与幂等写入语义。 */
function fakeSession(db: FakeDb) {
  return {
    async query(sql: string, params: Record<string, unknown> = {}) {
      db.queries.push(sql);
      const employee = recordIdString(params.employee);

      if (sql.includes("FROM $employee") && sql.startsWith("SELECT")) {
        const row = db.users.get(employee);
        if (!row) return [[]];
        const profile = (row.virtual_profile ?? {}) as Row;
        // EMPLOYEE_SELECT 把 virtual_profile.status/role_key 别名扁平为顶层字段。
        return [[{
          id: row.id, subject: row.subject, display_name: row.display_name, kind: row.kind,
          status: profile.status ?? null, role_key: profile.role_key ?? null,
        }]];
      }
      if (sql.startsWith("CREATE user:")) {
        const id = sql.match(/CREATE (user:\S+)/)?.[1] ?? "";
        if (db.users.has(id)) throw new Error(`Database record \`${id}\` already exists`);
        db.users.set(id, {
          id,
          email: params.email,
          subject: params.subject,
          kind: "virtual",
          display_name: params.displayName,
          virtual_profile: { status: null, role_key: params.roleKey, role: params.role },
        });
        return [[db.users.get(id)!]];
      }
      if (sql.startsWith("UPDATE $employee")) {
        const row = db.users.get(employee);
        if (!row) return [[]];
        const profile = { ...((row.virtual_profile ?? {}) as Row) };
        if (sql.includes('"paused"')) profile.status = "paused";
        if (sql.includes('"active"')) { profile.status = "active"; profile.last_active_at = new Date(); }
        if (sql.includes('"retired"')) { profile.status = "retired"; row.disabled_at = new Date(); }
        row.virtual_profile = profile;
        return [[row]];
      }
      if (sql.includes("FROM office_role")) {
        const found = [...db.roles.values()].filter((r) => r.key === params.key);
        return [found.map((r) => ({ id: r.id }))];
      }
      if (sql.includes("FROM employee_credential") && sql.startsWith("SELECT")) {
        const found = [...db.credentials.values()].filter((r) => recordIdString(r.employee) === employee);
        return [found];
      }
      if (sql.startsWith("INSERT INTO employee_credential")) {
        if (db.failCredentialWrites > 0) {
          db.failCredentialWrites -= 1;
          throw new Error("credential write exploded");
        }
        const key = recordIdString(params.credential);
        const dup = [...db.credentials.values()].find(
          (r) => recordIdString(r.employee) === employee || recordIdString(r.id) === key,
        );
        if (!dup) {
          db.credentials.set(key, {
            id: key,
            employee: params.employee,
            secret: params.secret,
            created_at: new Date(),
          });
        }
        // ON DUPLICATE KEY UPDATE employee = $employee：命中唯一索引时 no-op，保留原 secret。
        return [[]];
      }
      if (sql.startsWith("UPDATE employee_credential")) {
        const found = [...db.credentials.values()].find((r) => recordIdString(r.employee) === employee);
        if (found) { found.secret = params.secret; found.rotated_at = new Date(); }
        return [[]];
      }
      throw new Error(`unhandled sql: ${sql.slice(0, 80)}`);
    },
    async close() {},
  };
}

function fakeRuntime() {
  const registered: EmployeeSessionTarget[] = [];
  const closed: string[] = [];
  const forgotten: string[] = [];
  const runtime: EmployeeRuntime = {
    async register(target) { registered.push(target); },
    async close(database, employeeId, options) {
      closed.push(`${database}::${employeeId}`);
      if (options?.forgetSecret) forgotten.push(`${database}::${employeeId}`);
    },
    session: () => undefined,
    async secretFor() { return null; },
    async warmup() { return { databases: 0, credentials: 0 }; },
    activeSessions: () => registered.length,
    async stop() {},
  };
  return { runtime, registered, closed, forgotten };
}

function fixture(options: { failCredentialWrites?: number } = {}) {
  const db: FakeDb = {
    users: new Map(),
    credentials: new Map(),
    roles: new Map([["project-manager", { id: "office_role:pm", key: "project-manager" }]]),
    queries: [],
    failCredentialWrites: options.failCredentialWrites ?? 0,
  };
  const { runtime, registered, closed, forgotten } = fakeRuntime();
  const secrets: string[] = [];
  let tick = 0;
  const deps: EmployeeLifecycleDeps = {
    resolveWorkspace: async (slug) => (slug === "acme" ? { dbName: "ws_acme" } : null),
    callerSession: async () => fakeSession(db),
    rootSession: async () => fakeSession(db),
    runtime,
    generateSecret: () => `secret-${(tick += 1)}`,
    now: () => new Date("2026-09-30T00:00:00Z"),
    sessionTtlSeconds: 3600,
  };
  void secrets;
  return { lifecycle: createEmployeeLifecycle(deps), db, registered, closed, forgotten };
}

const provisionInput = { slug: "acme", callerToken: "tok", requestKey: "req-key-0001" };

describe("employee lifecycle provisioning", () => {
  test("create 注册会话、凭证落库，重试返回同一员工不产生第二条记录", async () => {
    const { lifecycle, db, registered } = fixture();
    const first = await lifecycle.provision(provisionInput);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.created).toBe(true);
    expect(first.employee.status).toBe("active");
    expect(first.employee.id).toMatch(/^user:ve_[0-9a-f]{24}$/);
    expect(registered).toHaveLength(1);
    expect(db.credentials.size).toBe(1);

    const again = await lifecycle.provision({ ...provisionInput, displayName: "另一个名字" });
    expect(again.kind).toBe("ok");
    if (again.kind !== "ok") return;
    expect(again.created).toBe(false);
    expect(again.employee.id).toBe(first.employee.id);
    expect(db.users.size).toBe(1);
    expect(db.credentials.size).toBe(1);
    // 幂等重放仍会确保 runtime 持有会话
    expect(registered).toHaveLength(2);
  });

  test("并发创建同一 requestKey 收敛到一个员工一条凭证", async () => {
    const { lifecycle, db } = fixture();
    const results = await Promise.all([
      lifecycle.provision(provisionInput),
      lifecycle.provision(provisionInput),
      lifecycle.provision(provisionInput),
    ]);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    const ids = new Set(results.map((r) => (r.kind === "ok" ? r.employee.id : "x")));
    expect(ids.size).toBe(1);
    expect(db.users.size).toBe(1);
    expect(db.credentials.size).toBe(1);
  });

  test("凭证写入失败留下不可 SIGNIN 的中间态，重试安全完成", async () => {
    const { lifecycle, db } = fixture({ failCredentialWrites: 1 });
    await expect(lifecycle.provision(provisionInput)).rejects.toThrow("credential write exploded");
    const [stuck] = [...db.users.values()];
    expect(stuck?.virtual_profile && (stuck.virtual_profile as Row).status).toBeNull();

    const retried = await lifecycle.provision(provisionInput);
    expect(retried.kind).toBe("ok");
    if (retried.kind !== "ok") return;
    expect(retried.employee.status).toBe("active");
    expect(db.credentials.size).toBe(1);
  });

  test("roleKey 解析到 office_role；未知岗位拒绝且不落任何记录", async () => {
    const { lifecycle, db } = fixture();
    const withRole = await lifecycle.provision({ ...provisionInput, roleKey: "project-manager" });
    expect(withRole.kind).toBe("ok");
    if (withRole.kind === "ok") expect(withRole.employee.roleKey).toBe("project-manager");

    const denied = await lifecycle.provision({ ...provisionInput, requestKey: "req-key-0002", roleKey: "ghost" });
    expect(denied.kind).toBe("role-not-found");
    expect(db.users.size).toBe(1);
  });

  test("未知 workspace 拒绝", async () => {
    const { lifecycle } = fixture();
    const result = await lifecycle.provision({ ...provisionInput, slug: "ghost" });
    expect(result.kind).toBe("workspace-not-found");
  });
});

describe("employee lifecycle transitions", () => {
  async function activeEmployee() {
    const f = fixture();
    const created = await f.lifecycle.provision(provisionInput);
    if (created.kind !== "ok") throw new Error("setup failed");
    return { ...f, employeeKey: created.employee.id.slice(5) };
  }

  test("pause→resume→retire 合法链路驱动 runtime 会话开合", async () => {
    const { lifecycle, registered, closed, forgotten, db, employeeKey } = await activeEmployee();
    expect((await lifecycle.pause("acme", employeeKey, "tok")).kind).toBe("ok");
    expect(closed).toEqual([`ws_acme::user:${employeeKey}`]);

    expect((await lifecycle.resume("acme", employeeKey, "tok")).kind).toBe("ok");
    expect(registered.length).toBe(2);

    const retired = await lifecycle.retire("acme", employeeKey, "tok");
    expect(retired.kind).toBe("ok");
    if (retired.kind !== "ok") return;
    expect(retired.employee.status).toBe("retired");
    expect(retired.credentialsExpireBy).toBe("2026-09-30T01:00:00.000Z");
    expect(forgotten).toEqual([`ws_acme::user:${employeeKey}`]);
    const credential = [...db.credentials.values()][0]!;
    expect(credential.rotated_at).toBeInstanceOf(Date);
  });

  test("同态重放幂等，非法迁移拒绝", async () => {
    const { lifecycle, db, employeeKey } = await activeEmployee();
    await lifecycle.pause("acme", employeeKey, "tok");
    const repause = await lifecycle.pause("acme", employeeKey, "tok");
    expect(repause.kind).toBe("ok");

    await lifecycle.retire("acme", employeeKey, "tok");
    const reretire = await lifecycle.retire("acme", employeeKey, "tok");
    expect(reretire.kind).toBe("ok");
    if (reretire.kind === "ok") expect(reretire.credentialsExpireBy).toBeDefined();

    const resumeRetired = await lifecycle.resume("acme", employeeKey, "tok");
    expect(resumeRetired).toEqual({ kind: "invalid-transition", status: "retired" });
    const pauseRetired = await lifecycle.pause("acme", employeeKey, "tok");
    expect(pauseRetired).toEqual({ kind: "invalid-transition", status: "retired" });

    const row = db.users.get(`user:${employeeKey}`)!;
    expect((row.virtual_profile as Row).status).toBe("retired");
  });

  test("pause/resume/retire 对不存在员工与真人记录拒绝", async () => {
    const { lifecycle, db } = fixture();
    db.users.set("user:human1", { id: "user:human1", kind: "human", subject: "h1" });
    expect((await lifecycle.pause("acme", "ghost_emp", "tok")).kind).toBe("employee-not-found");
    expect((await lifecycle.pause("acme", "human1", "tok")).kind).toBe("not-employee");
    expect((await lifecycle.pause("acme", "!!bad id", "tok")).kind).toBe("employee-id-invalid");
  });
});
