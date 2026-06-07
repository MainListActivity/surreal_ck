import { getRootDatabaseSession } from "../db/root-connection";
import { dateTimeTimestamp, toIsoDateTimeString } from "../db/surreal-values";
import { env } from "../env";

export type SurrealTokenScope = {
  db: string;
  ac: "admin" | "participant";
};

/** `_system` 库名；无 workspace 但可创建时登录此库承接首个 workspace 创建。 */
export const SYSTEM_DATABASE = "_system";

export type DefaultScopeResult =
  | {
      kind: "scope";
      scope: SurrealTokenScope;
      /** `_system.system_admin` 表是否已有任意行。 */
      canCreateWorkspace: boolean;
    }
  | {
      kind: "login-denied";
      reason: "no-workspace";
    };

export type DefaultScopeInput = {
  subject: string;
  email?: string;
};

export type WorkspaceListItem = {
  slug: string;
  name: string;
  dbName: string;
  role: "admin" | "participant";
  lastSelectedAt: string | null;
};

export type SwitchWorkspaceInput = {
  subject: string;
  email?: string;
  workspaceSlug?: string;
  dbName?: string;
};

export type SwitchWorkspaceResult =
  | {
      kind: "switched";
      scope: SurrealTokenScope;
    }
  | {
      kind: "forbidden";
    }
  | {
      kind: "drift";
    };

export type ListWorkspacesResult = {
  workspaces: WorkspaceListItem[];
  /** `_system.system_admin` 表是否已有任意行；有行即允许创建 workspace。 */
  canCreate: boolean;
};

export interface WorkspaceScopeModule {
  getDefaultScope(input: DefaultScopeInput): Promise<DefaultScopeResult>;
  listWorkspaces(input: { subject: string; email?: string }): Promise<ListWorkspacesResult>;
  switchWorkspace(input: SwitchWorkspaceInput): Promise<SwitchWorkspaceResult>;
}

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
  use(scope: { namespace: string; database: string }): Promise<unknown>;
};

export type WorkspaceScopeSessionFactory = (database: string, namespace: string) => Promise<Queryable>;

export type WorkspaceScopeModuleOptions = {
  db?: Queryable;
  getDbSession?: WorkspaceScopeSessionFactory;
  namespace?: string;
};

async function defaultGetDbSession(database: string, namespace: string): Promise<Queryable> {
  return getRootDatabaseSession(database, namespace);
}

async function useInjectedDb(db: Queryable, namespace: string, database: string): Promise<Queryable> {
  await db.use({ namespace, database });
  return db;
}

function isWorkspaceScopeModuleOptions(input: Queryable | WorkspaceScopeModuleOptions): input is WorkspaceScopeModuleOptions {
  return !("query" in input);
}

/** 查 `_system.system_admin` 是否已有任意行。调用方需已 use 到 _system。 */
async function hasSystemAdminRows(db: Queryable): Promise<boolean> {
  const result = await db.query("SELECT VALUE id FROM system_admin LIMIT 1;");
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) && rows.length > 0;
}

type WorkspaceIndexRow = {
  id?: unknown;
  subject?: unknown;
  db_name?: unknown;
  role?: unknown;
  last_selected_at?: unknown;
  joined_at?: unknown;
  email?: unknown;
  workspace?: {
    slug?: unknown;
    name?: unknown;
    status?: unknown;
  };
};

function rowsFromQueryResult(result: unknown): WorkspaceIndexRow[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) ? (rows as WorkspaceIndexRow[]) : [];
}

function timestamp(value: unknown): number {
  return dateTimeTimestamp(value);
}

function rowToScope(row: WorkspaceIndexRow): SurrealTokenScope | null {
  if (typeof row.db_name !== "string") return null;
  if (row.role !== "admin" && row.role !== "participant") return null;

  return {
    db: row.db_name,
    ac: row.role,
  };
}

function rowToWorkspaceListItem(row: WorkspaceIndexRow): WorkspaceListItem | null {
  const scope = rowToScope(row);
  if (!scope) return null;
  if (row.workspace?.status !== "active") return null;
  if (typeof row.workspace.slug !== "string") return null;
  if (typeof row.workspace.name !== "string") return null;

  return {
    slug: row.workspace.slug,
    name: row.workspace.name,
    dbName: scope.db,
    role: scope.ac,
    lastSelectedAt: toIsoDateTimeString(row.last_selected_at),
  };
}

function sortWorkspaceRows(left: WorkspaceIndexRow, right: WorkspaceIndexRow): number {
  const selectedDiff = timestamp(right.last_selected_at) - timestamp(left.last_selected_at);
  if (selectedDiff !== 0) return selectedDiff;
  return timestamp(left.joined_at) - timestamp(right.joined_at);
}

function identityFilter(input: { subject: string; email?: string }): {
  sql: string;
  params: { subject: string; email?: string };
} {
  const email = input.email?.trim();
  if (!email) {
    return {
      sql: "subject = $subject",
      params: { subject: input.subject },
    };
  }

  return {
    sql: "(subject = $subject OR (subject = NONE AND email = $email))",
    params: { subject: input.subject, email },
  };
}

function needsSubjectBind(row: WorkspaceIndexRow, subject: string): boolean {
  return row.subject !== subject;
}

export function createWorkspaceScopeModule(input?: Queryable | WorkspaceScopeModuleOptions): WorkspaceScopeModule {
  const options = input && isWorkspaceScopeModuleOptions(input) ? input : { db: input };
  const db = options.db;
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession ?? defaultGetDbSession;
  const getSystemDb = async () =>
    db ? await useInjectedDb(db, namespace, SYSTEM_DATABASE) : await getDbSession(SYSTEM_DATABASE, namespace);

  return {
    async getDefaultScope(input) {
      const client = await getSystemDb();
      const identity = identityFilter(input);

      const result = await client.query(
        `
          SELECT db_name, role, last_selected_at, joined_at, workspace
          FROM user_workspace_index
          WHERE ${identity.sql} AND disabled_at = NONE
          FETCH workspace;
        `,
        identity.params,
      );
      const rows = rowsFromQueryResult(result);

      const scope = rows
        .filter((row) => row.workspace?.status === "active")
        .sort(sortWorkspaceRows)
        .map(rowToScope)
        .find((candidate): candidate is SurrealTokenScope => candidate !== null);

      const canCreateWorkspace = await hasSystemAdminRows(client);

      if (scope) {
        return { kind: "scope", scope, canCreateWorkspace };
      }

      // system_admin 表有任意行时，允许无 workspace 的登录用户进入 _system，
      // 再通过后端 POST /api/workspaces 创建首个/后续 workspace。
      if (canCreateWorkspace) {
        return {
          kind: "scope",
          scope: { db: SYSTEM_DATABASE, ac: "admin" },
          canCreateWorkspace: true,
        };
      }

      return { kind: "login-denied", reason: "no-workspace" };
    },

    async listWorkspaces(input) {
      const client = await getSystemDb();
      const identity = identityFilter(input);

      const result = await client.query(
        `
          SELECT db_name, role, last_selected_at, joined_at, workspace
          FROM user_workspace_index
          WHERE ${identity.sql} AND disabled_at = NONE
          FETCH workspace;
        `,
        identity.params,
      );
      const rows = rowsFromQueryResult(result);

      const workspaces = rows
        .sort(sortWorkspaceRows)
        .map(rowToWorkspaceListItem)
        .filter((item): item is WorkspaceListItem => item !== null);

      const canCreate = await hasSystemAdminRows(client);

      return { workspaces, canCreate };
    },

    async switchWorkspace(input) {
      const client = await getSystemDb();
      const identity = identityFilter(input);
      const result = input.dbName
        ? await client.query(
            `
              SELECT id, subject, db_name, role, last_selected_at, joined_at, workspace, email
              FROM user_workspace_index
              WHERE ${identity.sql} AND disabled_at = NONE AND db_name = $dbName
              FETCH workspace;
            `,
            { ...identity.params, dbName: input.dbName },
          )
        : await client.query(
            `
              SELECT id, subject, db_name, role, last_selected_at, joined_at, workspace, email
              FROM user_workspace_index
              WHERE ${identity.sql}
                AND disabled_at = NONE
                AND workspace IN (SELECT VALUE id FROM workspace WHERE slug = $workspaceSlug)
              FETCH workspace;
            `,
            { ...identity.params, workspaceSlug: input.workspaceSlug },
          );

      const rows = rowsFromQueryResult(result);
      const row = rows.find((candidate) => rowToScope(candidate) !== null);
      if (!row || row.workspace?.status !== "active") {
        return { kind: "forbidden" };
      }

      const membership = row.id;
      if (membership === undefined || membership === null) {
        return { kind: "drift" };
      }

      const scope = rowToScope(row);
      if (!scope) {
        return { kind: "forbidden" };
      }

      const targetClient = db ? await useInjectedDb(db, namespace, scope.db) : await getDbSession(scope.db, namespace);

      let correctedRole: "admin" | "participant" | null = null;

      try {
        // Query human users matching current subject or email
        const userQueryResult = await targetClient.query(
          `SELECT id, subject, email, is_admin FROM user WHERE kind = 'human' AND (subject = $subject OR email = $email);`,
          { subject: input.subject, email: row.email },
        );

        const workspaceUsers = Array.isArray(userQueryResult) ? userQueryResult[0] : [];
        if (!Array.isArray(workspaceUsers)) {
          return { kind: "drift" };
        }

        // Scenario A: Exact subject match
        const exactMatch = workspaceUsers.find((u: any) => u.subject === input.subject);

        if (exactMatch) {
          correctedRole = exactMatch.is_admin === true ? "admin" : "participant";
        } else {
          // Scenario B: Match by email and bind subject (if subject is empty)
          const bindableMatch = workspaceUsers.find(
            (u: any) => u.email === row.email && (u.subject === null || u.subject === undefined || u.subject === ""),
          );

          if (bindableMatch) {
            // Bind subject in target db
            await targetClient.query("UPDATE $user SET subject = $subject;", {
              user: bindableMatch.id,
              subject: input.subject,
            });

            // Adjust role if needed
            correctedRole = bindableMatch.is_admin === true ? "admin" : "participant";
          } else {
            // Scenario C: No user matches, or matches by email but already has a different subject bound
            return { kind: "drift" };
          }
        }
      } finally {
        if (db) {
          await useInjectedDb(client, namespace, SYSTEM_DATABASE);
        }
      }

      if (needsSubjectBind(row, input.subject)) {
        await client.query("UPDATE $membership SET subject = $subject;", {
          membership,
          subject: input.subject,
        });
      }

      if (correctedRole && row.role !== correctedRole) {
        await client.query("UPDATE $membership SET role = $role;", {
          membership,
          role: correctedRole,
        });
        scope.ac = correctedRole;
      }

      await client.query("UPDATE $membership SET last_selected_at = time::now();", {
        membership,
      });

      return { kind: "switched", scope };
    },
  };
}
