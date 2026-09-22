import { DateTime } from "surrealdb";
import { importFingerprint } from "./import-batch";
import { openDataTableRuntime } from "./data-table-runtime";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";
import { validateGridFieldValue } from "@surreal-ck/shared/field-schema";

export const DATA_CHECK_RULES_VERSION = "field-constraints-v1";

export type DataCheckStatus = "processing" | "completed" | "partial" | "failed" | "cancelled";

export type DataCheckFinding = {
  id: string;
  category: "required" | "format";
  explanation: string;
  ruleKey: string;
  recordId: string;
  sheetId: string;
  field: string;
  evidenceFingerprint: string;
};

export type DataCheckRunSnapshot = {
  id: string;
  status: DataCheckStatus;
  scannedCount: number;
  totalCount: number;
  findingCount: number;
  stale: boolean;
  error: string | null;
  findings: DataCheckFinding[];
};

type StoredSheet = { id?: unknown; table_name?: unknown };
type StoredRun = {
  id?: unknown; status?: unknown; scanned_count?: unknown; total_count?: unknown;
  finding_count?: unknown; stale?: unknown; error?: unknown;
};
type StoredFinding = {
  id?: unknown; category?: unknown; explanation?: unknown; rule_key?: unknown;
  record?: unknown; sheet?: unknown; field?: unknown; evidence_fingerprint?: unknown;
};

export function createDataCheckService(conn: SurrealConn) {
  async function start(input: {
    workbookId: string;
    sheetIds?: string[];
    signal?: AbortSignal;
    onProgress?: (snapshot: DataCheckRunSnapshot) => void;
  }): Promise<DataCheckRunSnapshot> {
    const sheets = await conn.query<StoredSheet>(
      "SELECT id, table_name FROM sheet WHERE workbook = $workbook ORDER BY id ASC",
      { workbook: toRecordId(input.workbookId) },
    );
    const selected = input.sheetIds?.length
      ? sheets.filter((sheet) => input.sheetIds!.includes(recordValueToString(sheet.id) ?? ""))
      : sheets;
    const createdValue = await conn.createRecord<StoredRun | StoredRun[]>("data_check_run", {
      workbook: toRecordId(input.workbookId),
      scope_sheets: selected.map((sheet) => toRecordId(recordValueToString(sheet.id)!)),
      rules_version: DATA_CHECK_RULES_VERSION,
      status: "processing",
      scanned_count: 0,
      total_count: 0,
      finding_count: 0,
      stale: false,
    });
    const created = Array.isArray(createdValue) ? createdValue[0] : createdValue;
    const runId = recordValueToString(created.id);
    if (!runId) throw new Error("数据体检创建后未返回运行标识");
    let scannedCount = 0;
    let totalCount = 0;
    let stale = false;
    let failedSheets = 0;
    const errors: string[] = [];
    const findings: DataCheckFinding[] = [];

    try {
      for (const sheet of selected) {
        if (input.signal?.aborted) throw new DOMException("数据体检已取消", "AbortError");
        const sheetId = recordValueToString(sheet.id)!;
        let runtime: Awaited<ReturnType<typeof openDataTableRuntime>> | null = null;
        try {
          runtime = await openDataTableRuntime({
            conn,
            workbookId: input.workbookId,
            dataTableId: sheetId,
            query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
          });
          const scan = await runtime.scanAllRecords({
            pageSize: 500,
            signal: input.signal,
            onProgress: (sheetCount) => input.onProgress?.({
              id: runId, status: "processing", scannedCount: scannedCount + sheetCount,
              totalCount, findingCount: findings.length, stale, error: null, findings: [...findings],
            }),
          });
          scannedCount += scan.scannedCount;
          totalCount += scan.scannedCount;
          stale ||= scan.stale;
          for (const record of scan.records) {
            for (const column of runtime.snapshot.columns) {
              const messages = validateGridFieldValue(record.values[column.key], column);
              for (const explanation of messages) {
                const category = explanation === "必填" ? "required" as const : "format" as const;
                const ruleKey = `${category}:${column.key}`;
                const stableKey = importFingerprint({
                  workbook: input.workbookId, sheet: sheetId, record: record.id,
                  field: column.key, ruleKey, version: DATA_CHECK_RULES_VERSION,
                });
                const evidenceFingerprint = importFingerprint({ value: record.values[column.key], explanation });
                const rows = await conn.query<StoredFinding>(
                  `INSERT INTO data_check_finding {
                    workbook: $workbook, sheet: $sheet, record: $record, field: $field,
                    category: $category, rule_key: $ruleKey, rule_version: $ruleVersion,
                    explanation: $explanation, evidence_fingerprint: $evidenceFingerprint,
                    stable_key: $stableKey, first_run: $run, last_run: $run,
                    run_history: [$run], occurrences: 1
                  } ON DUPLICATE KEY UPDATE
                    last_run = $run,
                    run_history = array::union(run_history ?? [], [$run]),
                    occurrences += 1,
                    explanation = $explanation,
                    evidence_fingerprint = $evidenceFingerprint,
                    last_seen_at = time::now()
                  RETURN AFTER`,
                  {
                    workbook: toRecordId(input.workbookId), sheet: toRecordId(sheetId), record: toRecordId(record.id),
                    field: column.key, category, ruleKey, ruleVersion: DATA_CHECK_RULES_VERSION,
                    explanation, evidenceFingerprint, stableKey, run: toRecordId(runId),
                  },
                );
                findings.push(mapFinding(rows[0] ?? {
                  id: `data_check_finding:${stableKey}`, category, explanation, rule_key: ruleKey,
                  record: record.id, sheet: sheetId, field: column.key, evidence_fingerprint: evidenceFingerprint,
                }));
              }
            }
          }
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
          failedSheets += 1;
          errors.push(`${sheetId}: ${safeError(cause)}`);
        } finally {
          await runtime?.close().catch(() => undefined);
        }
        await conn.updateRecord(runId, {
          scanned_count: scannedCount, total_count: totalCount,
          finding_count: findings.length, stale,
        });
      }
      const status: DataCheckStatus = failedSheets === 0 ? "completed" : failedSheets === selected.length ? "failed" : "partial";
      const snapshot = { id: runId, status, scannedCount, totalCount, findingCount: findings.length, stale, error: errors.join("；") || null, findings };
      await finishRun(conn, snapshot);
      return snapshot;
    } catch (cause) {
      const cancelled = cause instanceof DOMException && cause.name === "AbortError";
      const snapshot: DataCheckRunSnapshot = {
        id: runId, status: cancelled ? "cancelled" : "failed", scannedCount, totalCount,
        findingCount: findings.length, stale: true, error: cancelled ? "用户已取消" : safeError(cause), findings,
      };
      await finishRun(conn, snapshot);
      return snapshot;
    }
  }

  async function load(runId: string): Promise<DataCheckRunSnapshot | null> {
    const [runs, findings] = await Promise.all([
      conn.query<StoredRun>("SELECT * FROM data_check_run WHERE id = $run LIMIT 1", { run: toRecordId(runId) }),
      conn.query<StoredFinding>("SELECT * FROM data_check_finding WHERE last_run = $run ORDER BY sheet, record, field", { run: toRecordId(runId) }),
    ]);
    const run = runs[0];
    if (!run) return null;
    return {
      id: recordValueToString(run.id) ?? runId,
      status: run.status as DataCheckStatus,
      scannedCount: Number(run.scanned_count ?? 0), totalCount: Number(run.total_count ?? 0),
      findingCount: Number(run.finding_count ?? findings.length), stale: run.stale === true,
      error: run.error == null ? null : String(run.error), findings: findings.map(mapFinding),
    };
  }

  async function loadLatest(workbookId: string): Promise<DataCheckRunSnapshot | null> {
    const rows = await conn.query<{ id?: unknown }>(
      "SELECT id FROM data_check_run WHERE workbook = $workbook ORDER BY started_at DESC LIMIT 1",
      { workbook: toRecordId(workbookId) },
    );
    const id = recordValueToString(rows[0]?.id);
    return id ? load(id) : null;
  }

  return { start, load, loadLatest };
}

async function finishRun(conn: SurrealConn, snapshot: DataCheckRunSnapshot): Promise<void> {
  await conn.updateRecord(snapshot.id, {
    status: snapshot.status, scanned_count: snapshot.scannedCount, total_count: snapshot.totalCount,
    finding_count: snapshot.findingCount, stale: snapshot.stale, error: snapshot.error ?? undefined,
    completed_at: new DateTime(new Date().toISOString()),
  });
}

function mapFinding(row: StoredFinding): DataCheckFinding {
  return {
    id: recordValueToString(row.id) ?? "", category: row.category as DataCheckFinding["category"],
    explanation: String(row.explanation ?? ""), ruleKey: String(row.rule_key ?? ""),
    recordId: recordValueToString(row.record) ?? "", sheetId: recordValueToString(row.sheet) ?? "",
    field: String(row.field ?? ""), evidenceFingerprint: String(row.evidence_fingerprint ?? ""),
  };
}

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
