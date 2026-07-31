import {
  type QuotaMigrationAnomaly,
  type QuotaMigrationLegacyEvidence,
  type QuotaMigrationPhysicalScan,
  type QuotaMigrationPhysicalTable,
} from "@surreal-ck/shared/native-quota";
import { jsonify } from "surrealdb";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { physicalScanChecksum } from "./model";

export type QuotaMigrationWorkspaceQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: unknown): unknown {
  return jsonify(value);
}

function statement(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

function rows(value: unknown, index: number): UnknownRecord[] {
  const result = statement(normalized(value), index);
  if (Array.isArray(result)) return result.filter(isRecord);
  return isRecord(result) ? [result] : [];
}

function firstObject(value: unknown, index = 0): UnknownRecord | undefined {
  return rows(value, index)[0];
}

function recordString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    typeof value === "object"
    && value !== null
    && typeof value.toString === "function"
  ) {
    const text = value.toString();
    return text.includes(":") ? text : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  ) {
    return BigInt(value);
  }
  if (
    typeof value === "string"
    && /^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    return BigInt(value);
  }
  return null;
}

function requiredCount(value: unknown, field: string): bigint {
  const result = count(value);
  if (result === null) {
    throw new Error(`invalid physical ${field} count`);
  }
  return result;
}

function optionalCount(value: unknown): string | null {
  return count(value)?.toString() ?? null;
}

function quoteIdentifier(value: string): string {
  if (value.length === 0) throw new Error("empty catalog identifier");
  return `\`${
    value
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("\0", "\\0")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "\\t")
  }\``;
}

function tableNamesFromDatabaseInfo(result: unknown): string[] {
  const info = firstObject(result);
  if (!info || !Array.isArray(info.tables)) {
    throw new Error("INFO FOR DATABASE STRUCTURE returned no table catalog");
  }
  const names = info.tables.map((entry) =>
    isRecord(entry) ? stringValue(entry.name) : null
  );
  if (names.some((name) => !name)) {
    throw new Error("INFO FOR DATABASE STRUCTURE returned an invalid table name");
  }
  return (names as string[]).sort((left, right) =>
    left.localeCompare(right)
  );
}

function quotaFieldCount(fields: readonly unknown[], tableName: string): bigint {
  let count = 0n;
  for (const field of fields) {
    const name = isRecord(field) ? stringValue(field.name) : null;
    if (!name) {
      throw new Error(
        `INFO FOR TABLE STRUCTURE returned an invalid field for ${tableName}`,
      );
    }
    // SurrealDB synthesizes a trailing `.*` container when a typed array has
    // explicit descendants. Native quota meters the user-defined descendants,
    // not this generated catalog parent.
    if (!name.endsWith(".*")) count += 1n;
  }
  return count;
}

export class SurrealQuotaPhysicalScanner {
  constructor(private readonly db: QuotaMigrationWorkspaceQueryClient) {}

  async scan(): Promise<QuotaMigrationPhysicalScan> {
    const databaseInfo = await this.db.query(
      "INFO FOR DATABASE STRUCTURE;",
    );
    const tableNames = tableNamesFromDatabaseInfo(databaseInfo);
    const tables: QuotaMigrationPhysicalTable[] = [];
    let totalFields = 0n;
    let totalRecords = 0n;

    for (const tableName of tableNames) {
      const table = quoteIdentifier(tableName);
      const result = await this.db.query(
        `INFO FOR TABLE ${table} STRUCTURE;
SELECT count() AS count FROM ${table} GROUP ALL;`,
      );
      const tableInfo = firstObject(result, 0);
      if (!tableInfo || !Array.isArray(tableInfo.fields)) {
        throw new Error(
          `INFO FOR TABLE STRUCTURE returned no fields for ${tableName}`,
        );
      }
      const fieldCount = quotaFieldCount(tableInfo.fields, tableName);
      const recordCount = requiredCount(
        firstObject(result, 1)?.count ?? 0,
        `${tableName} record`,
      );
      totalFields += fieldCount;
      totalRecords += recordCount;
      tables.push({
        table: tableName,
        field_count: fieldCount.toString(),
        record_count: recordCount.toString(),
      });
    }
    return {
      tables,
      totals: {
        table_count: BigInt(tables.length).toString(),
        field_count: totalFields.toString(),
        record_count: totalRecords.toString(),
      },
      scan_checksum: physicalScanChecksum(tables),
    };
  }
}

export type LegacyQuotaInventoryRead = Readonly<{
  evidence: QuotaMigrationLegacyEvidence;
  anomalies: readonly QuotaMigrationAnomaly[];
}>;

const SAFE_LEGACY_ENTITY_TABLE = /^ent_[a-z0-9_]{1,58}$/u;

export class SurrealLegacyQuotaInventoryReader {
  constructor(private readonly db: QuotaMigrationWorkspaceQueryClient) {}

  async read(database: string): Promise<LegacyQuotaInventoryRead> {
    const result = await this.db.query(
      `
        SELECT id, key, max_sheets, max_fields_per_sheet,
          max_records_per_sheet
        FROM resource_quota_plan
        ORDER BY key;
        SELECT plan, sheet_count
        FROM ONLY workspace_resource_quota:current;
        SELECT sheet, record_count
        FROM sheet_resource_usage
        ORDER BY sheet;
        SELECT id, table_name
        FROM sheet
        ORDER BY id;
      `,
    );
    const plans = rows(result, 0).flatMap((row) => {
      const id = recordString(row.id);
      const key = stringValue(row.key);
      const maxSheets = optionalCount(row.max_sheets);
      const maxFields = optionalCount(row.max_fields_per_sheet);
      const maxRecords = optionalCount(row.max_records_per_sheet);
      return id && key && maxSheets && maxFields && maxRecords
        ? [{
            plan_record: id,
            plan_key: key,
            max_sheets: maxSheets,
            max_fields_per_sheet: maxFields,
            max_records_per_sheet: maxRecords,
          }]
        : [];
    });
    const planById = new Map(plans.map((plan) => [
      plan.plan_record,
      plan,
    ]));
    const binding = firstObject(result, 1);
    const bindingPlan = recordString(binding?.plan);
    const boundPlan = bindingPlan ? planById.get(bindingPlan) : undefined;
    const sheets = rows(result, 3);
    const tableBySheet = new Map(
      sheets.flatMap((row) => {
        const id = recordString(row.id);
        return id
          ? [[id, stringValue(row.table_name)] as const]
          : [];
      }),
    );
    const anomalies: QuotaMigrationAnomaly[] = [];
    const unsafeTables = [...tableBySheet.values()].filter(
      (table): table is string =>
        table !== null && !SAFE_LEGACY_ENTITY_TABLE.test(table),
    );
    for (const table of unsafeTables) {
      anomalies.push({
        code: "legacy_event_target_invalid",
        severity: "blocker",
        details: { table },
      });
    }
    const dynamicTables = [...new Set(
      [...tableBySheet.values()].filter(
        (table): table is string =>
          table !== null && SAFE_LEGACY_ENTITY_TABLE.test(table),
      ),
    )].sort();
    const eventTables = ["sheet", ...dynamicTables];
    const native = new SurrealNativeQuotaClient(this.db);
    const events = await native.readLegacyQuotaEvents(database, eventTables);
    const eventTargets = eventTables.map((table) => ({
      table,
      event_present: events.get(table) === true,
    }));
    for (const event of eventTargets) {
      if (!event.event_present) {
        anomalies.push({
          code: "legacy_quota_event_missing",
          severity: "discrepancy",
          details: { table: event.table },
        });
      }
    }
    if (!binding || !bindingPlan || !boundPlan) {
      anomalies.push({
        code: "legacy_plan_binding_missing",
        severity: "discrepancy",
        details: {},
      });
    }

    return Object.freeze({
      evidence: {
        plans,
        plan_binding: binding && bindingPlan
          ? {
              plan_record: bindingPlan,
              plan_key: boundPlan?.plan_key ?? null,
              max_sheets: boundPlan?.max_sheets ?? null,
              max_fields_per_sheet:
                boundPlan?.max_fields_per_sheet ?? null,
              max_records_per_sheet:
                boundPlan?.max_records_per_sheet ?? null,
            }
          : null,
        counters: {
          sheet_count: optionalCount(binding?.sheet_count),
          per_sheet_records: rows(result, 2).flatMap((row) => {
            const sheet = recordString(row.sheet);
            const recordCount = optionalCount(row.record_count);
            return sheet && recordCount
              ? [{
                  sheet,
                  table: tableBySheet.get(sheet) ?? null,
                  record_count: recordCount,
                }]
              : [];
          }),
        },
        event_targets: eventTargets,
      },
      anomalies: Object.freeze(anomalies),
    });
  }
}
