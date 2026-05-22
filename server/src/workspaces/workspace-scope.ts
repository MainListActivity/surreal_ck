import { getRootConnection } from "../db/root-connection";

export type SurrealTokenScope = {
  db: string;
  ac: "admin" | "participant";
};

export type DefaultScopeResult =
  | {
      kind: "scope";
      scope: SurrealTokenScope;
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
    };

export interface WorkspaceScopeModule {
  getDefaultScope(input: DefaultScopeInput): Promise<DefaultScopeResult>;
  listWorkspaces(input: { subject: string }): Promise<WorkspaceListItem[]>;
  switchWorkspace(input: SwitchWorkspaceInput): Promise<SwitchWorkspaceResult>;
}

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type WorkspaceIndexRow = {
  id?: unknown;
  db_name?: unknown;
  role?: unknown;
  last_selected_at?: unknown;
  joined_at?: unknown;
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
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function rowToScope(row: WorkspaceIndexRow): SurrealTokenScope | null {
  if (typeof row.db_name !== "string") return null;
  if (row.role !== "admin" && row.role !== "participant") return null;

  return {
    db: row.db_name,
    ac: row.role,
  };
}

function dateTimeString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === "object" && value !== null && typeof Reflect.get(value, "toString") === "function") {
    const stringValue = String(value);
    const parsed = Date.parse(stringValue);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
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
    lastSelectedAt: dateTimeString(row.last_selected_at),
  };
}

function sortWorkspaceRows(left: WorkspaceIndexRow, right: WorkspaceIndexRow): number {
  const selectedDiff = timestamp(right.last_selected_at) - timestamp(left.last_selected_at);
  if (selectedDiff !== 0) return selectedDiff;
  return timestamp(left.joined_at) - timestamp(right.joined_at);
}

export function createWorkspaceScopeModule(db?: Queryable): WorkspaceScopeModule {
  return {
    async getDefaultScope(input) {
      const result = await (db ?? getRootConnection()).query(
        `
          SELECT db_name, role, last_selected_at, joined_at, workspace
          FROM user_workspace_index
          WHERE subject = $subject AND disabled_at = NONE
          FETCH workspace;
        `,
        { subject: input.subject },
      );

      const scope = rowsFromQueryResult(result)
        .filter((row) => row.workspace?.status === "active")
        .sort(sortWorkspaceRows)
        .map(rowToScope)
        .find((candidate): candidate is SurrealTokenScope => candidate !== null);

      return scope ? { kind: "scope", scope } : { kind: "login-denied", reason: "no-workspace" };
    },

    async listWorkspaces(input) {
      const result = await (db ?? getRootConnection()).query(
        `
          SELECT db_name, role, last_selected_at, joined_at, workspace
          FROM user_workspace_index
          WHERE subject = $subject AND disabled_at = NONE
          FETCH workspace;
        `,
        { subject: input.subject },
      );

      return rowsFromQueryResult(result)
        .sort(sortWorkspaceRows)
        .map(rowToWorkspaceListItem)
        .filter((item): item is WorkspaceListItem => item !== null);
    },

    async switchWorkspace(input) {
      const client = db ?? getRootConnection();
      const result = input.dbName
        ? await client.query(
            `
              SELECT id, db_name, role, last_selected_at, joined_at, workspace
              FROM user_workspace_index
              WHERE subject = $subject AND disabled_at = NONE AND db_name = $dbName
              FETCH workspace;
            `,
            { subject: input.subject, dbName: input.dbName },
          )
        : await client.query(
            `
              SELECT id, db_name, role, last_selected_at, joined_at, workspace
              FROM user_workspace_index
              WHERE subject = $subject
                AND disabled_at = NONE
                AND workspace IN (SELECT VALUE id FROM workspace WHERE slug = $workspaceSlug)
              FETCH workspace;
            `,
            { subject: input.subject, workspaceSlug: input.workspaceSlug },
          );

      const row = rowsFromQueryResult(result).find((candidate) => rowToScope(candidate) !== null);
      if (!row || row.workspace?.status !== "active") {
        return { kind: "forbidden" };
      }

      const scope = rowToScope(row);
      if (!scope) {
        return { kind: "forbidden" };
      }

      await client.query("UPDATE $membership SET last_selected_at = time::now();", {
        membership: row.id,
      });

      return { kind: "switched", scope };
    },
  };
}
