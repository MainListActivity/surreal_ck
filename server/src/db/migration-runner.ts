import { loadTemplateScripts, type WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import { env } from "../env";
import { getRootConnection } from "./root-connection";

export type MigrationClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type MigrateAllWorkspacesOptions = {
  namespace?: string;
  loadScripts?: () => Promise<WorkspaceTemplateScript[]>;
};

export type WorkspaceMigrationOutcome = {
  dbName: string;
  fromVersion: number;
  toVersion: number;
};

export type MigrateAllWorkspacesResult = {
  total: number;
  migrated: WorkspaceMigrationOutcome[];
};

const SYSTEM_DATABASE = "_system";

function readVersionResult(result: unknown): number {
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  const firstRow = Array.isArray(firstResult) ? firstResult[0] : undefined;
  const version = typeof firstRow === "object" && firstRow !== null ? Reflect.get(firstRow, "version") : undefined;
  return typeof version === "number" ? version : 0;
}

function readWorkspaceDbNames(result: unknown): string[] {
  const rows = Array.isArray(result) ? result[0] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (typeof row === "object" && row !== null ? Reflect.get(row, "db_name") : undefined))
    .filter((dbName): dbName is string => typeof dbName === "string");
}

async function readCurrentVersion(db: MigrationClient): Promise<number> {
  try {
    return readVersionResult(await db.query("SELECT version FROM schema_version:current;"));
  } catch {
    return 0;
  }
}

export async function migrateAllWorkspaces(
  db: MigrationClient = getRootConnection(),
  options: MigrateAllWorkspacesOptions = {},
): Promise<MigrateAllWorkspacesResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const loadScripts = options.loadScripts ?? (() => loadTemplateScripts({ oidcJwksUrl: env.OIDC_JWKS_URL }));

  await db.use({ namespace, database: SYSTEM_DATABASE });
  const dbNames = readWorkspaceDbNames(await db.query("SELECT db_name FROM workspace;"));

  if (dbNames.length === 0) {
    return { total: 0, migrated: [] };
  }

  const scripts = await loadScripts();
  const migrated: WorkspaceMigrationOutcome[] = [];

  for (const dbName of dbNames) {
    try {
      await db.use({ namespace, database: dbName });
      const fromVersion = await readCurrentVersion(db);
      const pending = scripts.filter((script) => script.version > fromVersion);

      for (const script of pending) {
        await db.query(script.sql);
        await db.query(
          "UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };",
          { version: script.version },
        );
      }

      const toVersion = scripts.at(-1)?.version ?? fromVersion;
      if (pending.length > 0) {
        migrated.push({ dbName, fromVersion, toVersion });
        console.info("[migration]", `${dbName}: ${fromVersion} → ${toVersion}`);
      }
    } catch (cause) {
      // fail-fast：已成功迁的 db 不回滚，但停止后续 db 并向运维暴露 M/N 进度。
      const progress = `${migrated.length}/${dbNames.length}`;
      console.error("[migration]", `${dbName} failed after ${progress} migrated; aborting startup`);
      throw new Error(`workspace migration failed on ${dbName} (${progress} migrated before failure)`, { cause });
    }
  }

  return { total: dbNames.length, migrated };
}
