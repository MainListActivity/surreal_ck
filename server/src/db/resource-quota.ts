import { buildRecordQuotaGuardSurql } from "@surreal-ck/shared/resource-quota";
import type { StringRecordId } from "surrealdb";
import { toStringRecordId } from "./surreal-values";

export type ResourceQuotaMigrationClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type InstallRecordQuotaGuardsResult = {
  installed: number;
};

type ExistingSheet = {
  id: StringRecordId;
  tableName: string;
};

function firstStatementRows(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  const first = result[0];
  return Array.isArray(first) ? first : result;
}

function readExistingSheets(result: unknown): ExistingSheet[] {
  return firstStatementRows(result).map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("invalid sheet row while installing resource quota guard");
    }
    const id = toStringRecordId(Reflect.get(row, "id"));
    const tableName = Reflect.get(row, "table_name");
    if (!id || typeof tableName !== "string") {
      throw new Error("invalid sheet metadata while installing resource quota guard");
    }
    return { id, tableName };
  });
}

function readCount(result: unknown): number {
  const row = firstStatementRows(result)[0];
  if (typeof row !== "object" || row === null) return 0;
  const count = Reflect.get(row, "count");
  return typeof count === "number" ? count : 0;
}

/**
 * workspace 020 迁移后，为迁移前已经存在的动态实体表回填记录用量并补装事件。
 * 新数据表由 web 的建表事务直接安装相同事件。
 */
export async function installExistingRecordQuotaGuards(
  client: ResourceQuotaMigrationClient,
): Promise<InstallRecordQuotaGuardsResult> {
  const sheets = readExistingSheets(
    await client.query("SELECT id, table_name FROM sheet ORDER BY id;"),
  );

  for (const sheet of sheets) {
    const guardSql = buildRecordQuotaGuardSurql({
      tableName: sheet.tableName,
      sheetId: sheet.id,
    });
    const recordCount = readCount(
      await client.query(
        "SELECT count() AS count FROM type::table($table) GROUP ALL;",
        { table: sheet.tableName },
      ),
    );
    await client.query(
      `INSERT INTO sheet_resource_usage {
         sheet: $sheet,
         record_count: $recordCount
       }
       ON DUPLICATE KEY UPDATE record_count = $recordCount;`,
      { sheet: sheet.id, recordCount },
    );
    await client.query(guardSql);
  }

  return { installed: sheets.length };
}
