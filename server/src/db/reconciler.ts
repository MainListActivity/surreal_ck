import type { StringRecordId } from "surrealdb";
import { env } from "../env";
import { getRootConnection } from "./root-connection";
import { toStringRecordId } from "./surreal-values";

export type ReconcileClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type ReconcileOptions = {
  namespace?: string;
};

export type ReconcileResult = {
  workspaces: number;
  users: number;
  drift: number;
  repaired: number;
  failedWorkspaces: string[];
};

const SYSTEM_DATABASE = "_system";

type WorkspaceRow = { id: StringRecordId; dbName: string };

type IndexRow = {
  id: StringRecordId;
  subject: string;
  email: string | null;
  role: "admin" | "participant";
};

type UserRow = {
  id: unknown;
  subject: string | null;
  email: string | null;
  isAdmin: boolean;
};

type DriftAction =
  | { kind: "add-index"; user: UserRow }
  | { kind: "fix-role"; index: IndexRow; role: "admin" | "participant" }
  | { kind: "flag-orphan-index"; index: IndexRow };

function roleFor(user: UserRow): "admin" | "participant" {
  return user.isAdmin ? "admin" : "participant";
}

function matchIndexForUser(user: UserRow, indexRows: IndexRow[]): IndexRow | undefined {
  return indexRows.find(
    (row) =>
      (user.subject !== null && row.subject === user.subject) ||
      (user.email !== null && row.email === user.email),
  );
}

/**
 * 比对一个 workspace 内 _system index 行与 ws db human user 行，产出修复动作。
 * 权威方向：role 以 ws db user.is_admin 为准；ws-only user 自动补 index；
 * index-only（ws 无对应 user）仅告警不删（MVP 避免误删历史归因）。
 */
export function classifyWorkspaceDrift(indexRows: IndexRow[], userRows: UserRow[]): DriftAction[] {
  const actions: DriftAction[] = [];
  const matchedIndexIds = new Set<unknown>();

  for (const user of userRows) {
    const index = matchIndexForUser(user, indexRows);
    if (!index) {
      actions.push({ kind: "add-index", user });
      continue;
    }
    matchedIndexIds.add(index.id);
    const role = roleFor(user);
    if (index.role !== role) {
      actions.push({ kind: "fix-role", index, role });
    }
  }

  for (const index of indexRows) {
    if (!matchedIndexIds.has(index.id)) {
      actions.push({ kind: "flag-orphan-index", index });
    }
  }

  return actions;
}

function firstRowArray(result: unknown): unknown[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) ? rows : [];
}

function readWorkspaces(result: unknown): WorkspaceRow[] {
  return firstRowArray(result)
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const dbName = Reflect.get(row, "db_name");
      if (typeof dbName !== "string") return null;
      const id = toStringRecordId(Reflect.get(row, "id"));
      if (!id) return null;
      return { id, dbName };
    })
    .filter((row): row is WorkspaceRow => row !== null);
}

function readIndexRows(result: unknown): IndexRow[] {
  return firstRowArray(result)
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const role = Reflect.get(row, "role");
      if (role !== "admin" && role !== "participant") return null;
      const subject = Reflect.get(row, "subject");
      const email = Reflect.get(row, "email");
      const id = toStringRecordId(Reflect.get(row, "id"));
      if (!id) return null;
      return {
        id,
        subject: typeof subject === "string" ? subject : "",
        email: typeof email === "string" ? email : null,
        role,
      };
    })
    .filter((row): row is IndexRow => row !== null);
}

function readUserRows(result: unknown): UserRow[] {
  return firstRowArray(result)
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const subject = Reflect.get(row, "subject");
      const email = Reflect.get(row, "email");
      return {
        id: Reflect.get(row, "id"),
        subject: typeof subject === "string" ? subject : null,
        email: typeof email === "string" ? email : null,
        isAdmin: Reflect.get(row, "is_admin") === true,
      };
    })
    .filter((row): row is UserRow => row !== null);
}

async function applyDriftActions(
  db: ReconcileClient,
  workspace: WorkspaceRow,
  actions: DriftAction[],
): Promise<number> {
  let repaired = 0;

  for (const action of actions) {
    if (action.kind === "add-index") {
      await db.query(
        `
          INSERT INTO user_workspace_index {
            subject: $subject,
            email: $email,
            workspace: $workspace,
            db_name: $dbName,
            role: $role
          }
          ON DUPLICATE KEY UPDATE role = $role, disabled_at = NONE;
        `,
        {
          subject: action.user.subject,
          email: action.user.email,
          workspace: workspace.id,
          dbName: workspace.dbName,
          role: roleFor(action.user),
        },
      );
      repaired += 1;
      console.warn("[reconcile] re-added missing index", { dbName: workspace.dbName, subject: action.user.subject });
    } else if (action.kind === "fix-role") {
      await db.query("UPDATE $membership SET role = $role;", {
        membership: action.index.id,
        role: action.role,
      });
      repaired += 1;
      console.warn("[reconcile] fixed index role", {
        dbName: workspace.dbName,
        subject: action.index.subject,
        role: action.role,
      });
    } else if (action.kind === "flag-orphan-index") {
      // MVP：ws db 已无对应 user，只告警不删（保留历史归因，避免误删）。
      console.warn("[reconcile] orphan index row (no matching workspace user)", {
        dbName: workspace.dbName,
        subject: action.index.subject,
      });
    }
  }

  return repaired;
}

export async function reconcileWorkspaceIndex(
  db: ReconcileClient = getRootConnection(),
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;

  await db.use({ namespace, database: SYSTEM_DATABASE });
  const workspaces = readWorkspaces(await db.query("SELECT id, db_name FROM workspace WHERE status = 'active';"));

  let userCount = 0;
  let drift = 0;
  let repaired = 0;
  const failedWorkspaces: string[] = [];

  for (const workspace of workspaces) {
    try {
      const indexResult = await db.query(
        "SELECT id, subject, email, role FROM user_workspace_index WHERE db_name = $dbName AND disabled_at = NONE;",
        { dbName: workspace.dbName },
      );
      const indexRows = readIndexRows(indexResult);

      await db.use({ namespace, database: workspace.dbName });
      const userRows = readUserRows(
        await db.query("SELECT id, subject, email, is_admin FROM user WHERE kind = 'human' AND disabled_at = NONE;"),
      );
      await db.use({ namespace, database: SYSTEM_DATABASE });

      userCount += userRows.length;

      const actions = classifyWorkspaceDrift(indexRows, userRows);
      drift += actions.length;
      repaired += await applyDriftActions(db, workspace, actions);
    } catch (cause) {
      // 单个 workspace db 不可达不应阻塞整轮校对；记入失败清单，下次心跳重试。
      failedWorkspaces.push(workspace.dbName);
      console.error("[reconcile] workspace failed; skipping", {
        dbName: workspace.dbName,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      // 把会话切回 _system，避免后续 workspace 在错误的 db 上查询。
      try {
        await db.use({ namespace, database: SYSTEM_DATABASE });
      } catch {
        // 连切回 _system 都失败说明 root 连接整体异常，留给下次心跳处理。
      }
    }
  }

  console.info("[reconcile]", {
    workspaces: workspaces.length,
    users: userCount,
    drift,
    repaired,
    failed: failedWorkspaces.length,
  });

  return {
    workspaces: workspaces.length,
    users: userCount,
    drift,
    repaired,
    failedWorkspaces,
  };
}

export type ReconcileLoopHandle = {
  stop(): void;
};

export type StartReconcileLoopOptions = {
  intervalSec?: number;
  /** 单轮校对动作；默认绑定 reconcileWorkspaceIndex。失败会被吞掉，不影响心跳。 */
  runOnce?: () => Promise<unknown>;
  // 定时器 handle 不约束具体类型（Bun Timer vs node Timeout 签名不一），用 unknown 解耦。
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

/**
 * 启动 _system index 校对心跳：进程启动立即跑一次，之后按 RECONCILE_INTERVAL_SEC 周期重复。
 * 心跳本身不阻塞 caller（首轮 fire-and-forget），单轮失败被吞，下个 tick 重试。
 */
export function startReconcileLoop(options: StartReconcileLoopOptions = {}): ReconcileLoopHandle {
  const intervalSec = options.intervalSec ?? env.RECONCILE_INTERVAL_SEC;
  const runOnce = options.runOnce ?? (() => reconcileWorkspaceIndex());
  const setIntervalFn: (handler: () => void, ms: number) => unknown =
    options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn: (handle: unknown) => void =
    options.clearInterval ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));

  const tick = () => {
    void Promise.resolve()
      .then(runOnce)
      .catch((cause) => {
        console.error("[reconcile] heartbeat run failed; will retry next tick", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  // 启动立即跑一次（不阻塞 boot）。
  tick();

  const handle = setIntervalFn(tick, intervalSec * 1000);

  return {
    stop() {
      clearIntervalFn(handle);
    },
  };
}
