import { createHash } from "node:crypto";
import { StringRecordId } from "surrealdb";
import type { EmployeeRuntime } from "./employee-runtime";

/**
 * 虚拟员工生命周期服务（VER02）：管理员驱动的幂等 create / pause / resume / retire。
 *
 * 身份模型约束（不可违背）：
 * - user 记录的全部写入走**调用者 admin 会话**（authenticate(rawToken) 出来的
 *   admin JWT access）；root 只碰 _system workspace 索引和 employee_credential
 *   （该表 PERMISSIONS NONE，任何 access 都够不到）。
 * - 幂等：requestKey 决定员工身份（subject / record id / email 全部由
 *   sha256(db:key) 派生），超时重试或并发重放收敛到同一条记录。user 先建但
 *   virtual_profile.status 留空，凭证写成功后才置 active——半途失败留下的是
 *   "无法 SIGNIN 且可安全重试"的中间态，不会出现看似 active 却登不进去的员工。
 * - RecordId 只在数据库边界用 StringRecordId 包裹，record 字段绝不传裸字符串。
 * - secret / token / root 凭证不出现在返回值与日志里。
 * - 同一员工的生命周期操作在进程内串行化，并发 pause/resume/retire 不交错。
 */

type Queryable = {
  query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>): PromiseLike<R>;
};

/** 调用者会话在一次生命周期操作内用完即关，不留悬挂 WS 连接。 */
type ClosableQueryable = Queryable & { close?(): Promise<unknown> };

export type EmployeeView = {
  id: string;
  subject: string;
  displayName: string | null;
  roleKey: string | null;
  /** provisioning = user 记录已建但凭证/激活未完成（可安全重试的中间态）。 */
  status: "provisioning" | "active" | "paused" | "retired";
};

export type EmployeeLifecycleResult =
  | { kind: "ok"; employee: EmployeeView; created: boolean; credentialsExpireBy?: string }
  | { kind: "caller-denied" }
  | { kind: "workspace-not-found" }
  | { kind: "employee-not-found" }
  | { kind: "not-employee" }
  | { kind: "role-not-found" }
  | { kind: "invalid-transition"; status: EmployeeView["status"] }
  | { kind: "employee-id-invalid" };

export type EmployeeLifecycleDeps = {
  /** _system root 会话：slug → db_name 解析（root 唯一的读职责）。 */
  resolveWorkspace(slug: string): Promise<{ dbName: string } | null>;
  /** 用调用者 OIDC rawToken authenticate 出目标 db 的会话（生产实现 = createCallerSession）。 */
  callerSession(database: string, rawToken: string): Promise<ClosableQueryable>;
  /** 目标 workspace root 会话：employee_credential 读写。 */
  rootSession(database: string): Promise<Queryable>;
  runtime: Pick<EmployeeRuntime, "register" | "close">;
  generateSecret?: () => string;
  now?: () => Date;
  /** employee access 会话时长（秒），退休时报告剩余有效窗口。 */
  sessionTtlSeconds?: number;
};

const DEFAULT_SESSION_TTL_SECONDS = 3600;
const EMPLOYEE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/i;

function employeeIdentity(database: string, requestKey: string): {
  recordKey: string;
  recordId: string;
  credentialKey: string;
  subject: string;
  email: string;
} {
  const hash = createHash("sha256").update(`${database}${requestKey}`).digest("hex").slice(0, 24);
  return {
    recordKey: `ve_${hash}`,
    recordId: `user:ve_${hash}`,
    credentialKey: `cred_${hash}`,
    subject: `ve-${hash}`,
    email: `ve-${hash}@virtual.local`,
  };
}

type EmployeeRow = {
  id?: unknown;
  subject?: unknown;
  display_name?: unknown;
  status?: unknown;
  role_key?: unknown;
  kind?: unknown;
};



function view(row: EmployeeRow): EmployeeView {
  const status = row.status;
  return {
    id: String(row.id),
    subject: typeof row.subject === "string" ? row.subject : "",
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    roleKey: typeof row.role_key === "string" ? row.role_key : null,
    status:
      status === "active" || status === "paused" || status === "retired"
        ? status
        : "provisioning",
  };
}

const EMPLOYEE_SELECT = `SELECT id, subject, display_name, kind,
  virtual_profile.status AS status, virtual_profile.role_key AS role_key
  FROM $employee LIMIT 1;`;

export function createEmployeeLifecycle(deps: EmployeeLifecycleDeps) {
  const generateSecret = deps.generateSecret ?? (() => `${crypto.randomUUID()}${crypto.randomUUID()}`);
  const now = deps.now ?? (() => new Date());
  const sessionTtlSeconds = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const inflight = new Map<string, Promise<unknown>>();

  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (inflight.get(key) ?? Promise.resolve()).then(work);
    const tracked = next.catch(() => undefined);
    inflight.set(key, tracked);
    return next.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
  }

  function employeeRecordId(raw: string): StringRecordId | null {
    const key = raw.startsWith("user:") ? raw.slice(5) : raw;
    if (!EMPLOYEE_KEY_PATTERN.test(key)) return null;
    return new StringRecordId(`user:${key}`);
  }

  /** 读凭证（不补写）；retire 复用此读取 rotated_at 计算剩余有效窗口。 */
  async function readCredential(
    database: string,
    employee: StringRecordId,
  ): Promise<{ secret: string; rotatedAt: Date | null } | null> {
    const root = await deps.rootSession(database);
    const [rows] = await root.query<[{ secret?: unknown; rotated_at?: unknown }[]]>(
      "SELECT secret, rotated_at FROM employee_credential WHERE employee = $employee LIMIT 1;",
      { employee },
    );
    const row = rows?.[0];
    if (!row || typeof row.secret !== "string" || !row.secret) return null;
    return {
      secret: row.secret,
      rotatedAt: row.rotated_at ? new Date(String(row.rotated_at)) : null,
    };
  }

  /**
   * 保证凭证存在并返回库内当前 secret。
   * employee_credential 有 employee 唯一索引：确定性 id + ON DUPLICATE KEY UPDATE
   * 让并发/重试收敛到同一行；写后回读胜出值，调用方永远用库里最新的 secret。
   */
  async function ensureCredential(
    database: string,
    employee: StringRecordId,
    credentialKey: string,
  ): Promise<{ secret: string; rotatedAt: Date | null }> {
    const existing = await readCredential(database, employee);
    if (existing) return existing;
    const root = await deps.rootSession(database);
    await root.query(
      `INSERT INTO employee_credential {
        id: $credential, employee: $employee, secret: $secret, created_at: time::now()
      } ON DUPLICATE KEY UPDATE employee = $employee;`,
      {
        credential: new StringRecordId(`employee_credential:${credentialKey}`),
        employee,
        secret: generateSecret(),
      },
    );
    const stored = await readCredential(database, employee);
    if (!stored) throw new Error("employee-credential-write-failed");
    return stored;
  }

  async function readEmployee(admin: Queryable, employee: StringRecordId): Promise<EmployeeRow | null> {
    const [rows] = await admin.query<[EmployeeRow[]]>(EMPLOYEE_SELECT, { employee });
    return rows?.[0] ?? null;
  }

  /** credentialKey 与 provision 派生保持一致：ve_<hash> → cred_<hash>；其它 id 用原名。 */
  function credentialKeyFor(employeeKey: string): string {
    return employeeKey.startsWith("ve_") ? `cred_${employeeKey.slice(3)}` : `cred_${employeeKey}`;
  }

  async function provision(input: {
    slug: string;
    callerToken: string;
    requestKey: string;
    displayName?: string;
    roleKey?: string;
  }): Promise<EmployeeLifecycleResult> {
    const workspace = await deps.resolveWorkspace(input.slug);
    if (!workspace) return { kind: "workspace-not-found" };
    const database = workspace.dbName;
    const identity = employeeIdentity(database, input.requestKey);
    const employee = new StringRecordId(identity.recordId);

    return serialized(`${database}::${identity.recordId}`, async () => {
      let admin: ClosableQueryable;
      try {
        admin = await deps.callerSession(database, input.callerToken);
      } catch {
        return { kind: "caller-denied" };
      }
      try {

      let role: StringRecordId | null = null;
      if (input.roleKey) {
        const [roleRows] = await admin.query<[{ id?: unknown }[]]>(
          "SELECT id FROM office_role WHERE key = $key LIMIT 1;",
          { key: input.roleKey },
        );
      if (!roleRows?.[0]?.id) return { kind: "role-not-found" };
      role = new StringRecordId(String(roleRows[0].id));
      }

      let row = await readEmployee(admin, employee);
      let created = false;
      if (!row) {
        try {
          // 先建记录但 status 留空：凭证写成功前无法 SIGNIN，半途失败可安全重试。
          // option 字段不能绑 JS null——引擎把 null 当 NULL 而非 NONE，类型强转
          // 直接拒收（"Expected none | record<…> but found NULL"）；无岗位时整段省略。
          const virtualProfile = input.roleKey && role
            ? { role_key: input.roleKey, role }
            : {};
          await admin.query(
            `CREATE ${identity.recordId} CONTENT {
              email: $email, subject: $subject, kind: "virtual", is_admin: false,
              display_name: $displayName,
              virtual_profile: $virtualProfile
            };`,
            {
              email: identity.email,
              subject: identity.subject,
              displayName: input.displayName ?? "虚拟员工",
              virtualProfile,
            },
          );
          created = true;
        } catch {
          // 并发创建撞 id / 唯一索引：回读已存在记录，收敛到同一员工。
          console.warn("[employee-lifecycle] create returned error, re-reading", {
            employeeId: identity.recordId,
            code: "employee-create-retry",
          });
        }
        row ??= await readEmployee(admin, employee);
        if (!row) throw new Error("employee-create-failed");
      }
      if (row.kind !== "virtual") return { kind: "not-employee" };
      const current = view(row);

      const credential = await ensureCredential(database, employee, identity.credentialKey);

      // status 留空 = 上次供给半途失败：补激活。paused / retired 是有意状态，不擅自复活。
      if (current.status === "provisioning") {
        await admin.query(
          `UPDATE $employee SET
            virtual_profile.status = "active",
            virtual_profile.last_active_at = time::now();`,
          { employee },
        );
        current.status = "active";
      }

      if (current.status === "active") {
        await deps.runtime.register({
          database,
          employeeId: identity.recordId,
          subject: current.subject || identity.subject,
          secret: credential.secret,
        }, { activate: true });
      }
      return { kind: "ok", employee: current, created };
      } finally {
        await admin.close?.().catch(() => undefined);
      }
    });
  }

  type Transition = "pause" | "resume" | "retire";

  async function transit(
    slug: string,
    rawEmployeeId: string,
    callerToken: string,
    action: Transition,
  ): Promise<EmployeeLifecycleResult> {
    const workspace = await deps.resolveWorkspace(slug);
    if (!workspace) return { kind: "workspace-not-found" };
    const database = workspace.dbName;
    const employee = employeeRecordId(rawEmployeeId);
    if (!employee) return { kind: "employee-id-invalid" };
    const employeeId = String(employee);

    return serialized(`${database}::${employeeId}`, async () => {
      let admin: ClosableQueryable;
      try {
        admin = await deps.callerSession(database, callerToken);
      } catch {
        return { kind: "caller-denied" };
      }
      let row: EmployeeRow | null;
      try {
      row = await readEmployee(admin, employee);
      if (!row) return { kind: "employee-not-found" };
      if (row.kind !== "virtual") return { kind: "not-employee" };
      const current = view(row);

      // 合法源状态集；同态重放幂等返回，非法迁移（如复活 retired）拒绝。
      const legal: Record<Transition, ReadonlyArray<EmployeeView["status"]>> = {
        pause: ["active", "paused"],
        resume: ["paused", "active"],
        retire: ["provisioning", "active", "paused", "retired"],
      };
      if (!legal[action].includes(current.status)) {
        return { kind: "invalid-transition", status: current.status };
      }

      if (action === "pause") {
        if (current.status === "active") {
          await admin.query(`UPDATE $employee SET virtual_profile.status = "paused";`, { employee });
        }
        await deps.runtime.close(database, employeeId);
        return { kind: "ok", employee: { ...current, status: "paused" }, created: false };
      }

      if (action === "resume") {
        if (current.status === "paused") {
          const credential = await ensureCredential(
            database,
            employee,
            credentialKeyFor(employeeId.slice(5)),
          );
          await admin.query(
            `UPDATE $employee SET virtual_profile.status = "active", virtual_profile.last_active_at = time::now();`,
            { employee },
          );
          await deps.runtime.register({
            database,
            employeeId,
            subject: current.subject,
            secret: credential.secret,
          }, { activate: true });
        }
        return { kind: "ok", employee: { ...current, status: "active" }, created: false };
      }

      // retire：已退休幂等返回（附剩余 token 窗口 = rotated_at + TTL）。
      if (current.status === "retired") {
        await deps.runtime.close(database, employeeId, { forgetSecret: true });
        const credential = await readCredential(database, employee);
        const expireBy = credential?.rotatedAt
          ? new Date(credential.rotatedAt.getTime() + sessionTtlSeconds * 1000)
          : null;
        return {
          kind: "ok",
          employee: current,
          created: false,
          ...(expireBy ? { credentialsExpireBy: expireBy.toISOString() } : {}),
        };
      }

      // 状态落 retired + 旋转凭证：存量短 token 在 session TTL 内自然死亡，
      // runtime 关连接并忘掉 secret，此后 SIGNIN 被 status 与 secret 双重拒绝。
      await admin.query(
        `UPDATE $employee SET virtual_profile.status = "retired", disabled_at = time::now();`,
        { employee },
      );
      const root = await deps.rootSession(database);
      await root.query(
        `UPDATE employee_credential SET secret = $secret, rotated_at = time::now()
          WHERE employee = $employee;`,
        { employee, secret: generateSecret() },
      );
      await deps.runtime.close(database, employeeId, { forgetSecret: true });
      return {
        kind: "ok",
        employee: { ...current, status: "retired" },
        created: false,
        credentialsExpireBy: new Date(now().getTime() + sessionTtlSeconds * 1000).toISOString(),
      };
      } finally {
        await admin.close?.().catch(() => undefined);
      }
    });
  }

  return {
    provision,
    pause: (slug: string, employeeId: string, callerToken: string) =>
      transit(slug, employeeId, callerToken, "pause"),
    resume: (slug: string, employeeId: string, callerToken: string) =>
      transit(slug, employeeId, callerToken, "resume"),
    retire: (slug: string, employeeId: string, callerToken: string) =>
      transit(slug, employeeId, callerToken, "retire"),
  };
}

export type EmployeeLifecycle = ReturnType<typeof createEmployeeLifecycle>;
