import { loadPlatformContentScripts, type PlatformContentSchemaScript } from "@surreal-ck/shared/platform-content-schema";
import { env } from "../env";
import { getRootConnection } from "../db/root-connection";
import { StringRecordId } from "surrealdb";
import { toSurrealNone } from "../db/surreal-values";

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

type FacetRow = {
  id?: unknown; item?: unknown; version?: unknown; kind?: unknown;
  jurisdiction?: unknown; published_on?: unknown; effective_on?: unknown;
};

/** Add safe facet rows for versions published before the search schema existed. */
async function backfillSearchFacets(db: PlatformContentSchemaClient): Promise<void> {
  let cursor: StringRecordId | null = null;
  while (true) {
    const result = await db.query(
      `SELECT id, item, version, item.kind AS kind, version.source.jurisdiction AS jurisdiction,
        version.published_on AS published_on,
        version.content_kind_payload.legislation.effectiveOn AS effective_on
        FROM content_publication_projection ${cursor ? "WHERE id > $cursor" : ""}
        ORDER BY id ASC LIMIT 500;`,
      cursor ? { cursor } : {},
    );
    const records = Array.isArray(result) && Array.isArray(result[0]) ? result[0] as FacetRow[] : [];
    for (const row of records) {
      if (!row.id || !row.item || !row.version || typeof row.kind !== "string") {
        throw new Error("published content is missing search facet identity");
      }
      const item = new StringRecordId(String(row.item));
      const version = new StringRecordId(String(row.version));
      const existing = await db.query("SELECT id FROM content_search_facet WHERE item = $item LIMIT 1;", { item });
      if (Array.isArray(existing) && Array.isArray(existing[0]) && existing[0].length > 0) continue;
      await db.query(`CREATE content_search_facet CONTENT {
        item: $item, version: $version, kind: $kind, jurisdiction: $jurisdiction,
        published_on: $publishedOn, effective_on: $effectiveOn
      };`, {
        item, version, kind: row.kind,
        jurisdiction: toSurrealNone(typeof row.jurisdiction === "string" ? row.jurisdiction : null),
        publishedOn: toSurrealNone(typeof row.published_on === "string" ? row.published_on : null),
        effectiveOn: toSurrealNone(typeof row.effective_on === "string" ? row.effective_on : null),
      });
    }
    if (records.length < 500) return;
    cursor = new StringRecordId(String(records.at(-1)!.id));
  }
}

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
      if (script.version === 7) await backfillSearchFacets(client);
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
