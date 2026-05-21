import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env";
import { getRootConnection } from "./root-connection";

export type SystemSchemaClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type EnsureSystemSchemaOptions = {
  migrationsDir?: string;
  namespace?: string;
};

export type EnsureSystemSchemaResult = {
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
};

type MigrationFile = {
  version: number;
  name: string;
  path: string;
};

const SYSTEM_DATABASE = "_system";
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../shared/sql/system", import.meta.url));

function readVersionResult(result: unknown): number {
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  const firstRow = Array.isArray(firstResult) ? firstResult[0] : undefined;
  const version = typeof firstRow === "object" && firstRow !== null ? Reflect.get(firstRow, "version") : undefined;
  return typeof version === "number" ? version : 0;
}

async function readCurrentVersion(db: SystemSchemaClient): Promise<number> {
  try {
    return readVersionResult(await db.query("SELECT version FROM _system_schema_version:current;"));
  } catch {
    return 0;
  }
}

async function loadMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && /^\d{3}-.+\.surql$/.test(entry.name))
    .map((entry) => ({
      version: Number(entry.name.slice(0, 3)),
      name: entry.name,
      path: join(migrationsDir, entry.name),
    }))
    .sort((left, right) => left.version - right.version);
}

export async function ensureSystemSchema(
  db: SystemSchemaClient = getRootConnection(),
  options: EnsureSystemSchemaOptions = {},
): Promise<EnsureSystemSchemaResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  await db.query(`DEFINE DATABASE IF NOT EXISTS ${SYSTEM_DATABASE};`);
  await db.use({ namespace, database: SYSTEM_DATABASE });

  const fromVersion = await readCurrentVersion(db);
  const migrations = await loadMigrations(migrationsDir);
  const pendingMigrations = migrations.filter((migration) => migration.version > fromVersion);
  const appliedVersions: number[] = [];

  for (const migration of pendingMigrations) {
    const sql = await readFile(migration.path, "utf8");
    await db.query(sql);
    await db.query(
      "UPSERT _system_schema_version:current CONTENT { version: $version, applied_at: time::now() };",
      { version: migration.version },
    );
    appliedVersions.push(migration.version);
    console.info("[system-schema] applied migration", { version: migration.version, name: migration.name });
  }

  return {
    fromVersion,
    toVersion: migrations.at(-1)?.version ?? fromVersion,
    appliedVersions,
  };
}
