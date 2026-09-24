import { DateTime, RecordId, StringRecordId } from "surrealdb";

export const CONTENT_MIGRATION_TABLES = [
  "content_source",
  "source_license_revision",
  "content_item",
  "content_source_record",
  "content_version",
  "legal_article_version",
  "content_citation",
  "citation_resolution",
  "cites_article",
  "cites_legislation",
  "ingestion_batch",
  "ingestion_entry",
  "validation_revision",
  "publication_request",
  "publication_item_result",
  "publication_event",
  "content_publication_projection",
  "platform_content_audit_event",
] as const;

type Row = Record<string, unknown>;
type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type MigrationTarget = Queryable & {
  select(id: StringRecordId): PromiseLike<unknown>;
  create(id: StringRecordId): { content(data: Row): PromiseLike<unknown> };
  relate(from: StringRecordId, edge: RecordId, to: StringRecordId, data: Row): PromiseLike<unknown>;
  upsert(id: StringRecordId): { content(data: Row): PromiseLike<unknown> };
};
export type ContentMigrationSummary = Record<(typeof CONTENT_MIGRATION_TABLES)[number], number>;

const CONTENT_REFERENCE_FIELDS = {
  content_source: [],
  source_license_revision: ["source"],
  content_item: ["current_version"],
  content_source_record: ["source", "item"],
  content_version: ["item", "source"],
  legal_article_version: ["regulation_version"],
  content_citation: ["document_version"],
  citation_resolution: ["citation"],
  cites_article: ["in", "out", "resolution_revision"],
  cites_legislation: ["in", "out", "resolution_revision"],
  ingestion_batch: ["supersedes_batch"],
  ingestion_entry: ["batch", "target_item", "expected_version"],
  validation_revision: ["entry"],
  publication_request: ["batch"],
  publication_item_result: ["request", "version"],
  publication_event: ["request", "entry", "item", "version"],
  content_publication_projection: ["item", "version"],
  platform_content_audit_event: ["batch", "entry"],
} as const satisfies Record<(typeof CONTENT_MIGRATION_TABLES)[number], readonly string[]>;

function rows(result: unknown): Row[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error("content migration query failed");
  return result[0].filter((row): row is Row => row !== null && typeof row === "object" && !Array.isArray(row));
}

function recordId(value: unknown): StringRecordId {
  const valueText = String(value);
  if (!/^[a-z_]+:[^\s]+$/u.test(valueText)) throw new Error(`invalid content record ID: ${valueText}`);
  return new StringRecordId(valueText);
}

function relationId(value: unknown): RecordId {
  const text = String(value);
  const divider = text.indexOf(":");
  if (divider < 1 || divider === text.length - 1) throw new Error("invalid content relation ID");
  return new RecordId(text.slice(0, divider), text.slice(divider + 1));
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    const name = value.constructor?.name;
    if (name === "RecordId" || name === "StringRecordId" || name === "DateTime") return String(value);
    return Object.fromEntries(Object.entries(value as Row)
      .filter(([key]) => key !== "updated_at" && key !== "last_seen_at")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, comparable(child)]));
  }
  return value;
}

function assertSame(source: Row, target: Row, table: string): void {
  if (JSON.stringify(comparable(source)) !== JSON.stringify(comparable(target))) {
    throw new Error(`content migration mismatch in ${table}/${String(source.id)}`);
  }
}

async function allRows(db: Queryable, table: string): Promise<Row[]> {
  const output: Row[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = rows(await db.query(`SELECT * FROM ${table} ORDER BY id ASC LIMIT 100 START $offset;`, { offset }));
    output.push(...page);
    if (page.length < 100) return output;
  }
}

/** Startup permits new target-only writes but still verifies every frozen legacy row. */
export async function verifyLegacyContentCopy(
  source: Queryable,
  target: Queryable,
  allowAdditionalTargetRows = false,
): Promise<ContentMigrationSummary> {
  const summary = {} as ContentMigrationSummary;
  const references: Array<{ from: string; field: string; to: string }> = [];
  const targetIds = new Set<string>();
  for (const table of CONTENT_MIGRATION_TABLES) {
    const sourceRows = await allRows(source, table);
    const targetRows = await allRows(target, table);
    if ((!allowAdditionalTargetRows && targetRows.length !== sourceRows.length)
      || (allowAdditionalTargetRows && targetRows.length < sourceRows.length)) {
      throw new Error(`content migration count mismatch in ${table}: ${sourceRows.length} != ${targetRows.length}`);
    }
    const targetById = new Map(targetRows.map((row) => [String(row.id), row]));
    for (const targetRow of targetRows) targetIds.add(String(targetRow.id));
    for (const sourceRow of sourceRows) {
      const id = String(sourceRow.id);
      const targetRow = targetById.get(id);
      if (!targetRow) throw new Error(`missing migrated record in ${table}/${id}`);
      assertSame(sourceRow, targetRow, table);
      for (const field of CONTENT_REFERENCE_FIELDS[table]) {
        const value = sourceRow[field];
        if (value !== null && value !== undefined) {
          references.push({ from: id, field, to: String(value) });
        }
      }
    }
    if (!allowAdditionalTargetRows) {
      const sourceIds = new Set(sourceRows.map((row) => String(row.id)));
      for (const targetRow of targetRows) {
        if (!sourceIds.has(String(targetRow.id))) {
          throw new Error(`unexpected target record in ${table}/${String(targetRow.id)}`);
        }
      }
    }
    summary[table] = sourceRows.length;
  }
  for (const reference of references) {
    if (!targetIds.has(reference.to)) {
      throw new Error(`broken migrated reference ${reference.from}.${reference.field} -> ${reference.to}`);
    }
  }
  return summary;
}

/** Call only after all legacy writers are frozen; repeat to resume a partial copy. */
export async function migrateLegacyPlatformContent(input: Readonly<{
  source: Queryable;
  target: MigrationTarget;
  writesFrozen: boolean;
}>): Promise<ContentMigrationSummary> {
  if (!input.writesFrozen) throw new Error("legacy content writes must be frozen before migration");
  for (const table of CONTENT_MIGRATION_TABLES) {
    const sourceRows = await allRows(input.source, table);
    for (const source of sourceRows) {
      const id = recordId(source.id);
      const existingValue = await input.target.select(id);
      const existing = existingValue && typeof existingValue === "object" ? existingValue as Row : undefined;
      if (!existing) {
        const { id: _id, ...content } = source;
        if (table === "cites_article" || table === "cites_legislation") {
          const { in: from, out: to, ...properties } = content;
          await input.target.relate(recordId(from), relationId(id), recordId(to), properties);
        } else {
          await input.target.create(id).content(content);
        }
      } else {
        assertSame(source, existing, table);
      }
    }
  }
  const summary = await verifyLegacyContentCopy(input.source, input.target);
  await input.target.upsert(new StringRecordId("content_migration_state:legacy")).content({
    source_database: "_system",
    verified_at: new DateTime(new Date()),
    summary,
  });
  return summary;
}

export async function assertLegacyContentMigrated(source: Queryable, target: Queryable): Promise<void> {
  const info = await source.query("INFO FOR DB;");
  const metadata = Array.isArray(info) ? info[0] : undefined;
  const defined = metadata && typeof metadata === "object" ? Reflect.get(metadata, "tables") : undefined;
  if (!defined || typeof defined !== "object") throw new Error("cannot inspect legacy database tables");
  const tables = CONTENT_MIGRATION_TABLES.filter((table) => Object.hasOwn(defined, table));
  const checks = await Promise.all(tables.map((table) =>
    source.query(`SELECT id FROM ${table} LIMIT 1;`),
  ));
  if (checks.every((result) => rows(result).length === 0)) return;
  const marker = rows(await target.query("SELECT * FROM content_migration_state:legacy;"))[0];
  if (!marker || marker.source_database !== "_system") {
    throw new Error("legacy platform content exists in _system; run the frozen-write migration before switching the publisher");
  }
  await verifyLegacyContentCopy(source, target, true);
}
