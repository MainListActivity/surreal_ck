import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";
import type { StringRecordId } from "surrealdb";

export type WorkspaceSettingsClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type WorkspaceSettingsSessionFactory = (
  database: string,
  namespace: string,
) => Promise<WorkspaceSettingsClient>;

export type RenameWorkspaceInput = {
  callerSubject: string;
  slug: string;
  name: string;
};

export type RenameWorkspaceResult =
  | { kind: "renamed" }
  | { kind: "forbidden" }
  | { kind: "workspace-not-found" };

export interface WorkspaceSettingsManager {
  renameWorkspace(input: RenameWorkspaceInput): Promise<RenameWorkspaceResult>;
}

export type WorkspaceSettingsManagerOptions = {
  getDbSession?: WorkspaceSettingsSessionFactory;
  namespace?: string;
};

const SYSTEM_DATABASE = "_system";

async function defaultGetDbSession(database: string, namespace: string): Promise<WorkspaceSettingsClient> {
  return getRootDatabaseSession(database, namespace);
}

type WorkspaceRef = { workspaceId: StringRecordId; dbName: string };

export function createWorkspaceSettingsManager(options: WorkspaceSettingsManagerOptions = {}): WorkspaceSettingsManager {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession ?? defaultGetDbSession;

  async function resolveWorkspace(systemDb: WorkspaceSettingsClient, slug: string): Promise<WorkspaceRef | null> {
    const result = await systemDb.query(
      "SELECT id, db_name, status FROM workspace WHERE slug = $slug LIMIT 1;",
      { slug },
    );
    const row = firstRow(result);
    if (!row || readString(row, "db_name") === null || readString(row, "status") !== "active") {
      return null;
    }
    const workspaceId = toStringRecordId(Reflect.get(row, "id"));
    if (!workspaceId) {
      return null;
    }
    return { workspaceId, dbName: readString(row, "db_name") as string };
  }

  async function callerIsAdmin(workspaceDb: WorkspaceSettingsClient, callerSubject: string): Promise<boolean> {
    const result = await workspaceDb.query(
      "SELECT is_admin FROM user WHERE kind = 'human' AND subject = $callerSubject AND disabled_at = NONE LIMIT 1;",
      { callerSubject },
    );
    const row = firstRow(result);
    return row !== null && Reflect.get(row, "is_admin") === true;
  }

  return {
    async renameWorkspace(input) {
      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);
      const workspace = await resolveWorkspace(systemDb, input.slug);
      if (!workspace) {
        return { kind: "workspace-not-found" };
      }

      const workspaceDb = await getDbSession(workspace.dbName, namespace);
      if (!(await callerIsAdmin(workspaceDb, input.callerSubject))) {
        return { kind: "forbidden" };
      }

      await systemDb.query("UPDATE $workspace SET name = $name;", {
        workspace: workspace.workspaceId,
        name: input.name,
      });

      return { kind: "renamed" };
    },
  };
}

function firstRow(result: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(result) ? result[0] : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = Reflect.get(row, key);
  return typeof value === "string" ? value : null;
}
