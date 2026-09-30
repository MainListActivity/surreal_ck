import { StringRecordId, Surreal } from "surrealdb";

/**
 * 虚拟员工会话 runtime（VER02）：进程内的 employee access 会话注册表 + secret 缓存。
 *
 * - 会话即执行窗口的载体：register() 立即 SIGNIN 并登记；close() 关闭并摘除。
 *   暂停/退休的员工在 DB 层由 employee access 的 SIGNIN query 拒绝（status != "active"），
 *   本模块不再保留其会话，"不再接受新执行窗口"由这两条共同保证。
 * - secret 只进不出：缓存仅供 SIGNIN，绝不出现在返回值或日志里；日志只带
 *   database / employeeId。
 * - 重启后注册表为空：warmup() 遍历 active workspace 把 employee_credential 重新
 *   装载进 secret 缓存（不开会话）；会话按需由调用方再次 register。
 */

type EmployeeKey = `${string}::${string}`;

export type EmployeeSessionTarget = {
  /** 目标 workspace database 名。 */
  database: string;
  /** user record id（如 "user:ve_ab12…"）。 */
  employeeId: string;
  /** employee SIGNIN 用的 user.subject。 */
  subject: string;
  /** employee_credential.secret。 */
  secret: string;
};

type Queryable = {
  query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>): PromiseLike<R>;
};

export type EmployeeRuntimeDeps = {
  surrealUrl: string;
  namespace: string;
  /** 测试注入连接工厂；默认 new Surreal()。 */
  connect?: () => Surreal;
  /** root 会话工厂（读 employee_credential；凭证表 PERMISSIONS NONE，只有 root 能读）。 */
  rootSession?: (database: string) => Promise<Queryable>;
  /** _system 会话工厂（warmup 遍历 workspace 索引）。 */
  systemSession?: () => Promise<Queryable>;
};

export type EmployeeRuntime = {
  /** 注册并 SIGNIN 一条员工会话；同员工已有会话先关闭再替换，不产生并发双连接。 */
  register(target: EmployeeSessionTarget): Promise<void>;
  /** 关闭并移除会话。forgetSecret=true（退休）时连 secret 缓存一并丢弃。 */
  close(database: string, employeeId: string, options?: { forgetSecret?: boolean }): Promise<void>;
  /** 当前存活会话；未注册返回 undefined，绝不隐式重建。 */
  session(database: string, employeeId: string): Surreal | undefined;
  /** 取缓存 secret；未命中且给了 rootSession 时回源 employee_credential。 */
  secretFor(database: string, employeeId: string): Promise<string | null>;
  /** 进程启动后回装凭证缓存（遍历 active workspace → employee_credential，不开会话）。 */
  warmup(): Promise<{ databases: number; credentials: number }>;
  activeSessions(): number;
  stop(): Promise<void>;
};

const keyOf = (database: string, employeeId: string): EmployeeKey => `${database}::${employeeId}`;

export function createEmployeeRuntime(deps: EmployeeRuntimeDeps): EmployeeRuntime {
  const sessions = new Map<EmployeeKey, Surreal>();
  const secrets = new Map<EmployeeKey, string>();
  const subjects = new Map<EmployeeKey, string>();
  const inflight = new Map<EmployeeKey, Promise<void>>();
  let stopped = false;

  async function closeSession(key: EmployeeKey): Promise<void> {
    const previous = sessions.get(key);
    sessions.delete(key);
    if (previous) await previous.close().catch(() => undefined);
  }

  async function doRegister(target: EmployeeSessionTarget): Promise<void> {
    if (stopped) throw new Error("employee-runtime-stopped");
    const key = keyOf(target.database, target.employeeId);
    await closeSession(key);
    const db = deps.connect ? deps.connect() : new Surreal();
    try {
      await db.connect(deps.surrealUrl, {
        reconnect: false,
        namespace: deps.namespace,
        database: target.database,
      });
      await db.signin({
        namespace: deps.namespace,
        database: target.database,
        access: "employee",
        variables: { subject: target.subject, pass: target.secret },
      });
    } catch (cause) {
      await db.close().catch(() => undefined);
      console.warn("[employee-runtime] employee signin refused", {
        database: target.database,
        employeeId: target.employeeId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
    if (stopped) {
      await db.close().catch(() => undefined);
      throw new Error("employee-runtime-stopped");
    }
    sessions.set(key, db);
    secrets.set(key, target.secret);
    subjects.set(key, target.subject);
  }

  return {
    async register(target) {
      const key = keyOf(target.database, target.employeeId);
      const next = (inflight.get(key) ?? Promise.resolve()).then(() => doRegister(target));
      const tracked = next.catch(() => undefined);
      inflight.set(key, tracked);
      try {
        await next;
      } finally {
        if (inflight.get(key) === tracked) inflight.delete(key);
      }
    },

    async close(database, employeeId, options) {
      const key = keyOf(database, employeeId);
      await closeSession(key);
      if (options?.forgetSecret) secrets.delete(key);
    },

    session(database, employeeId) {
      return sessions.get(keyOf(database, employeeId));
    },

    async secretFor(database, employeeId) {
      const key = keyOf(database, employeeId);
      const cached = secrets.get(key);
      if (cached) return cached;
      if (!deps.rootSession) return null;
      const root = await deps.rootSession(database);
      const [rows] = await root.query<[{ secret?: unknown; subject?: unknown }[]]>(
        `SELECT secret, employee.subject AS subject FROM employee_credential
          WHERE employee = $employee LIMIT 1;`,
        { employee: new StringRecordId(employeeId) },
      );
      const row = rows?.[0];
      if (typeof row?.secret !== "string" || !row.secret) return null;
      secrets.set(key, row.secret);
      if (typeof row.subject === "string") subjects.set(key, row.subject);
      return row.secret;
    },

    async warmup() {
      if (!deps.systemSession || !deps.rootSession) return { databases: 0, credentials: 0 };
      const system = await deps.systemSession();
      const [workspaces] = await system.query<[{ db_name?: unknown }[]]>(
        'SELECT db_name FROM workspace WHERE status = "active";',
      );
      let credentials = 0;
      for (const workspace of workspaces ?? []) {
        const database = typeof workspace.db_name === "string" ? workspace.db_name : "";
        if (!database) continue;
        const root = await deps.rootSession(database);
        const [rows] = await root.query<[{ employee?: unknown; secret?: unknown; subject?: unknown }[]]>(
          "SELECT employee, secret, employee.subject AS subject FROM employee_credential;",
        );
        for (const row of rows ?? []) {
          if (row.employee == null) continue;
          if (typeof row.secret !== "string" || !row.secret) continue;
          const employeeId = String(row.employee);
          secrets.set(keyOf(database, employeeId), row.secret);
          if (typeof row.subject === "string") subjects.set(keyOf(database, employeeId), row.subject);
          credentials += 1;
        }
      }
      return { databases: (workspaces ?? []).length, credentials };
    },

    activeSessions() {
      return sessions.size;
    },

    async stop() {
      stopped = true;
      const all = [...sessions.values()];
      sessions.clear();
      secrets.clear();
      subjects.clear();
      await Promise.allSettled(all.map((db) => db.close()));
    },
  };
}
