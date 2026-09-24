import { loadPlatformContentScripts, type PlatformContentSchemaScript } from "@surreal-ck/shared/platform-content-schema";
import { env } from "../env";
import { getRootConnection } from "../db/root-connection";

export type PlatformContentSchemaClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type EnsurePlatformContentSchemaOptions = {
  namespace?: string;
  database?: string;
  loadScripts?: () => Promise<PlatformContentSchemaScript[]>;
};

export type EnsurePlatformContentSchemaResult = {
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
};

const DEFAULT_DATABASE = "platform_content";

function readVersionResult(result: unknown): number {
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  const firstRow = Array.isArray(firstResult) ? firstResult[0] : undefined;
  const value = firstRow && typeof firstRow === "object" ? Reflect.get(firstRow, "version") : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function readCurrentVersion(db: PlatformContentSchemaClient): Promise<number> {
  try {
    return readVersionResult(await db.query("SELECT version FROM platform_content_schema_version:current;"));
  } catch {
    return 0;
  }
}

/** 在独立 database 以连续版本安全应用平台内容 schema。 */
export async function ensurePlatformContentSchema(
  db?: PlatformContentSchemaClient,
  options: EnsurePlatformContentSchemaOptions = {},
): Promise<EnsurePlatformContentSchemaResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const database = options.database ?? env.CONTENT_DATABASE ?? DEFAULT_DATABASE;
  if (database === "_system") throw new Error("platform content must use an isolated database");
  const loadScripts = options.loadScripts ?? (() => loadPlatformContentScripts());
  const ownedSession = db ? null : await getRootConnection().forkSession();
  const client = db ?? ownedSession!;
  try {
    await client.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
    await client.use({ namespace, database });
    const fromVersion = await readCurrentVersion(client);
    const scripts = await loadScripts();
    const pending = scripts.filter((script) => script.version > fromVersion);
    const appliedVersions: number[] = [];
    for (const script of pending) {
      await client.query(script.sql);
      await client.query(
        "UPSERT platform_content_schema_version:current CONTENT { version: $version, applied_at: time::now() };",
        { version: script.version },
      );
      appliedVersions.push(script.version);
    }
    return { fromVersion, toVersion: scripts.at(-1)?.version ?? fromVersion, appliedVersions };
  } finally {
    await ownedSession?.closeSession();
  }
}
