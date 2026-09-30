import { StringRecordId, Surreal } from "surrealdb";

/**
 * 虚拟员工会话 runtime（VER02）：进程内的 employee access 会话注册表 + secret 缓存。
 *
 * - 会话即执行窗口的载体：register() 立即 SIGNIN 并登记；close() 关闭并摘除。
 *   暂停/退休的员工在 DB 层由 employee access 的 SIGNIN query 拒绝（status != "active"），
 *   close 立即封住会话获取并作废旧注册，直到生命周期显式 activate。
 * - secret 只进不出：缓存仅供 SIGNIN，绝不出现在返回值或日志里；日志只带
 *   白名单事件 / 随机实例标识。
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
  /** 固定探测超时；生产默认 1500ms。 */
  probeTimeoutMs?: number;
  /** root 会话工厂（读 employee_credential；凭证表 PERMISSIONS NONE，只有 root 能读）。 */
  rootSession?: (database: string) => Promise<Queryable>;
  /** _system 会话工厂（warmup 遍历 workspace 索引）。 */
  systemSession?: () => Promise<Queryable>;
};

export type EmployeeCredential = { subject: string; secret: string };

export type EmployeeRuntime = {
  /** 注册并 SIGNIN；先确认关闭旧连接。activate 仅供生命周期确认 active 后解除暂停。 */
  register(target: EmployeeSessionTarget, options?: { activate?: boolean }): Promise<void>;
  /** 关闭并移除会话；deactivate 持续封禁（暂停），forgetSecret 永久封禁（退休）。 */
  close(database: string, employeeId: string, options?: { forgetSecret?: boolean; deactivate?: boolean }): Promise<void>;
  /** 当前允许获取的会话；暂停/停止/未注册返回 undefined，绝不隐式重建。 */
  session(database: string, employeeId: string): Surreal | undefined;
  /** 取缓存 secret；未命中且给了 rootSession 时回源 employee_credential。 */
  secretFor(database: string, employeeId: string): Promise<string | null>;
  /** 取 SIGNIN 所需完整凭证（subject+secret）；缓存未命中时回源 employee_credential。 */
  credentialFor(database: string, employeeId: string): Promise<EmployeeCredential | null>;
  /**
   * 为一个执行窗口打开员工会话：解析凭证 → register（SIGNIN）→ 返回会话。
   * 已有会话先被替换，保证窗口拿到的总是新鲜 token（session TTL 很短）。
   */
  openSession(database: string, employeeId: string): Promise<Surreal>;
  /** 进程启动后回装凭证缓存（遍历 active workspace → employee_credential，不开会话）。 */
  warmup(): Promise<{ databases: number; credentials: number }>;
  inspect(database: string, employeeId: string): Promise<EmployeeRuntimeObservation>;
  activeSessions(): number;
  stop(): Promise<void>;
};

export type EmployeeRuntimeObservation = {
  database: string;
  employeeId: string;
  instanceId: string;
  sampledAt: string;
  sessionPresent: boolean;
  /** 当前由本员工 runtime 持有的连接对象数（含连接中/关闭失败），非全局总数。 */
  connectionCount: number;
  usable: boolean;
  generation: number;
  lastRegisteredAt: string | null;
  lastClosedAt: string | null;
  closeConfirmed: boolean | null;
  probeCode: "ok" | "absent" | "unavailable" | "timeout" | "changed";
};

type ObservationState = Pick<EmployeeRuntimeObservation,
  "generation" | "lastRegisteredAt" | "lastClosedAt" | "closeConfirmed">;

const keyOf = (database: string, employeeId: string): EmployeeKey => `${database}::${employeeId}`;

export function createEmployeeRuntime(deps: EmployeeRuntimeDeps): EmployeeRuntime {
  const sessions = new Map<EmployeeKey, Surreal>();
  const secrets = new Map<EmployeeKey, string>();
  const subjects = new Map<EmployeeKey, string>();
  const inflight = new Map<EmployeeKey, Promise<void>>();
  const blocked = new Set<EmployeeKey>();
  const retired = new Set<EmployeeKey>();
  const suspended = new Set<EmployeeKey>();
  const connections = new Map<EmployeeKey, Set<Surreal>>();
  const epochs = new Map<EmployeeKey, number>();
  const closing = new Map<EmployeeKey, Set<Surreal>>();
  const observations = new Map<EmployeeKey, ObservationState>();
  const instanceId = crypto.randomUUID();
  let stopped = false;

  const emptyState = (): ObservationState => ({ generation: 0, lastRegisteredAt: null, lastClosedAt: null, closeConfirmed: null });

  function state(key: EmployeeKey): ObservationState {
    let value = observations.get(key);
    if (!value) {
      value = emptyState();
      observations.set(key, value);
    }
    return value;
  }

  // 日志只发固定事件和随机实例标识；不输出输入、SDK 错误或错误链。
  function event(code: "registered" | "closed" | "close-failed" | "signin-failed") {
    console.info("[employee-runtime]", { event: code, instanceId });
  }

  function serialized<T>(key: EmployeeKey, work: () => Promise<T>): Promise<T> {
    const next = (inflight.get(key) ?? Promise.resolve()).then(work);
    const tracked = next.then(() => undefined, () => undefined);
    inflight.set(key, tracked);
    return next.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
  }

  async function closeConnection(key: EmployeeKey, db: Surreal): Promise<void> {
    const pending = closing.get(key) ?? new Set<Surreal>();
    pending.add(db);
    closing.set(key, pending);
    state(key).closeConfirmed = null;
    try {
      await db.close();
    } catch {
      state(key).closeConfirmed = false;
      event("close-failed");
      throw new Error("employee-close-failed");
    }
    connections.get(key)?.delete(db);
    if (connections.get(key)?.size === 0) connections.delete(key);
    pending.delete(db);
    if (pending.size === 0) closing.delete(key);
    state(key).lastClosedAt = new Date().toISOString();
    state(key).closeConfirmed = pending.size === 0;
    event("closed");
  }

  async function closeSession(key: EmployeeKey): Promise<void> {
    const previous = sessions.get(key);
    sessions.delete(key);
    const all = new Set(closing.get(key));
    if (previous) all.add(previous);
    for (const db of all) await closeConnection(key, db);
  }

  function allowed(key: EmployeeKey, epoch: number): boolean {
    return !stopped && !blocked.has(key) && (epochs.get(key) ?? 0) === epoch;
  }

  async function doRegister(target: EmployeeSessionTarget, epoch: number): Promise<void> {
    const key = keyOf(target.database, target.employeeId);
    if (!allowed(key, epoch)) throw new Error(stopped ? "employee-runtime-stopped" : "employee-session-blocked");
    await closeSession(key);
    if (!allowed(key, epoch)) throw new Error("employee-session-blocked");
    const db = deps.connect ? deps.connect() : new Surreal();
    const owned = connections.get(key) ?? new Set<Surreal>();
    owned.add(db);
    connections.set(key, owned);
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
    } catch {
      event("signin-failed");
      await closeConnection(key, db);
      throw new Error("employee-signin-failed");
    }
    if (!allowed(key, epoch)) {
      await closeConnection(key, db);
      throw new Error(stopped ? "employee-runtime-stopped" : "employee-session-blocked");
    }
    sessions.set(key, db);
    secrets.set(key, target.secret);
    subjects.set(key, target.subject);
    state(key).generation += 1;
    state(key).lastRegisteredAt = new Date().toISOString();
    event("registered");
  }

  return {
    async register(target, options) {
      const key = keyOf(target.database, target.employeeId);
      // 只有生命周期服务在确认 active 后可解除暂停；执行窗口不能隐式复活。
      if (options?.activate && !stopped && !retired.has(key)) {
        suspended.delete(key);
        blocked.delete(key);
      }
      const epoch = epochs.get(key) ?? 0;
      await serialized(key, () => doRegister(target, epoch));
    },

    async close(database, employeeId, options) {
      const key = keyOf(database, employeeId);
      blocked.add(key);
      if (connections.get(key)?.size) state(key).closeConfirmed = null;
      const epoch = (epochs.get(key) ?? 0) + 1;
      epochs.set(key, epoch);
      if (options?.deactivate || options?.forgetSecret) suspended.add(key);
      if (options?.forgetSecret) {
        retired.add(key);
        secrets.delete(key);
        subjects.delete(key);
      }
      await serialized(key, async () => {
        await closeSession(key);
        // 窗口结束只关闭连接；生命周期暂停/退休才持续封禁。
        if (!suspended.has(key) && epochs.get(key) === epoch) blocked.delete(key);
      });
    },

    session(database, employeeId) {
      const key = keyOf(database, employeeId);
      return stopped || blocked.has(key) ? undefined : sessions.get(key);
    },

    async inspect(database, employeeId) {
      const key = keyOf(database, employeeId);
      const db = this.session(database, employeeId);
      const epoch = epochs.get(key) ?? 0;
      const generation = observations.get(key)?.generation ?? 0;
      let probeCode: EmployeeRuntimeObservation["probeCode"] = "absent";
      if (db) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          probeCode = await Promise.race([
            // SDK auth() 固定读取当前 $auth，不接受 SQL/参数，不 SIGNIN、不重连、不写业务。
            Promise.resolve(db.auth<{ virtual_profile?: { status?: string } }>()).then(
              (row): EmployeeRuntimeObservation["probeCode"] =>
                row && String(row.id) === employeeId && row.virtual_profile?.status === "active"
                  ? "ok" : "unavailable",
              (): EmployeeRuntimeObservation["probeCode"] => "unavailable",
            ),
            new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), deps.probeTimeoutMs ?? 1500);
            }),
          ]);
        } catch {
          probeCode = "unavailable";
        } finally {
          clearTimeout(timer);
        }
        if (this.session(database, employeeId) !== db || (epochs.get(key) ?? 0) !== epoch || state(key).generation !== generation) {
          probeCode = "changed";
        }
      }
      return {
        database, employeeId, instanceId, sampledAt: new Date().toISOString(),
        sessionPresent: !!this.session(database, employeeId), connectionCount: connections.get(key)?.size ?? 0, usable: probeCode === "ok",
        ...(observations.get(key) ?? emptyState()), probeCode,
      };
    },

    async secretFor(database, employeeId) {
      return (await this.credentialFor(database, employeeId))?.secret ?? null;
    },

    async credentialFor(database, employeeId) {
      const key = keyOf(database, employeeId);
      const cachedSecret = secrets.get(key);
      const cachedSubject = subjects.get(key);
      if (cachedSecret && cachedSubject) return { subject: cachedSubject, secret: cachedSecret };
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
      const subject = subjects.get(key);
      return subject ? { subject, secret: row.secret } : null;
    },

    async openSession(database, employeeId) {
      const key = keyOf(database, employeeId);
      const epoch = epochs.get(key) ?? 0;
      if (!allowed(key, epoch)) throw new Error("employee-session-blocked");
      const credential = await this.credentialFor(database, employeeId);
      if (!allowed(key, epoch)) throw new Error("employee-session-blocked");
      if (!credential) throw new Error("employee-credential-missing");
      await this.register({
        database,
        employeeId,
        subject: credential.subject,
        secret: credential.secret,
      });
      const session = this.session(database, employeeId);
      if (!session) throw new Error("employee-session-unavailable");
      return session;
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
      await Promise.all([...inflight.values()]);
      const keys = new Set([...sessions.keys(), ...closing.keys()]);
      const results = await Promise.allSettled([...keys].map((key) => closeSession(key)));
      secrets.clear();
      subjects.clear();
      if (results.some((result) => result.status === "rejected")) throw new Error("employee-close-failed");
    },
  };
}
