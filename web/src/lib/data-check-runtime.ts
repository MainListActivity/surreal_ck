import { DateTime } from "surrealdb";
import { importFingerprint } from "./import-batch";
import { openDataTableRuntime } from "./data-table-runtime";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";
import { validateGridFieldValue } from "@surreal-ck/shared/field-schema";
import type { WorkbookTemplateSheet } from "@surreal-ck/shared/dto";
import {
  evaluateTemplateCheckRules,
  parseTemplateCheckRules,
  type ScannedTemplateSheet,
} from "./template-check-rules";

export const DATA_CHECK_RULES_VERSION = "field-constraints-v1";

export type DataCheckStatus = "processing" | "completed" | "partial" | "failed" | "cancelled";

export type DataCheckFinding = {
  id: string;
  category: "required" | "format" | "duplicate_candidate" | "reference_missing" | "reference_unverifiable" | "consistency";
  explanation: string;
  ruleKey: string;
  ruleVersion: string;
  recordId: string;
  sheetId: string;
  field: string;
  evidenceFingerprint: string;
  status: "pending" | "processing" | "pending_review" | "closed" | "not_applicable";
  resolutionReason: string | null;
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
  rulesVersion: string;
};

type StoredSheet = { id?: unknown; table_name?: unknown; template_sheet_key?: unknown };
type StoredRun = {
  id?: unknown; status?: unknown; scanned_count?: unknown; total_count?: unknown;
  finding_count?: unknown; stale?: unknown; error?: unknown; rules_version?: unknown;
};
type StoredFinding = {
  id?: unknown; category?: unknown; explanation?: unknown; rule_key?: unknown;
  rule_version?: unknown; record?: unknown; sheet?: unknown; field?: unknown; evidence_fingerprint?: unknown;
  status?: unknown; resolution_reason?: unknown;
};

export function createDataCheckService(conn: SurrealConn) {
  async function start(input: {
    workbookId: string;
    sheetIds?: string[];
    signal?: AbortSignal;
    onProgress?: (snapshot: DataCheckRunSnapshot) => void;
  }): Promise<DataCheckRunSnapshot> {
    const sheets = await conn.query<StoredSheet>(
      "SELECT id, table_name, template_sheet_key FROM sheet WHERE workbook = $workbook ORDER BY id ASC",
      { workbook: toRecordId(input.workbookId) },
    );
    const selected = input.sheetIds?.length
      ? sheets.filter((sheet) => input.sheetIds!.includes(recordValueToString(sheet.id) ?? ""))
      : sheets;
    const templateRules = await loadTemplateRules(conn, input.workbookId);
    const rulesVersion = templateRules
      ? `${DATA_CHECK_RULES_VERSION}+template:${templateRules.version}`
      : DATA_CHECK_RULES_VERSION;
    const createdValue = await conn.createRecord<StoredRun | StoredRun[]>("data_check_run", {
      workbook: toRecordId(input.workbookId),
      scope_sheets: selected.map((sheet) => toRecordId(recordValueToString(sheet.id)!)),
      rules_version: rulesVersion,
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
    const scannedByTemplateKey = new Map<string, ScannedTemplateSheet>();
    const sheetIdByTemplateKey = new Map<string, string>();
    for (const sheet of selected) {
      const key = typeof sheet.template_sheet_key === "string" ? sheet.template_sheet_key : undefined;
      if (!key) continue;
      scannedByTemplateKey.set(key, { sheetKey: key, records: [], readable: false });
      sheetIdByTemplateKey.set(key, recordValueToString(sheet.id)!);
    }

    async function persistFinding(candidate: Omit<DataCheckFinding, "id"> & { stableEvidence: unknown }): Promise<void> {
      const stableKey = importFingerprint({
        workbook: input.workbookId, sheet: candidate.sheetId, record: candidate.recordId,
        field: candidate.field, ruleKey: candidate.ruleKey, version: candidate.ruleVersion,
        stableEvidence: candidate.stableEvidence,
      });
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
          active_assignment = IF status INSIDE ["closed", "not_applicable"] THEN NONE ELSE active_assignment END,
          handlers = IF status INSIDE ["closed", "not_applicable"] THEN [] ELSE handlers ?? [] END,
          resolution_reason = IF status INSIDE ["pending_review", "closed", "not_applicable"] OR evidence_fingerprint != $evidenceFingerprint THEN NONE ELSE resolution_reason END,
          resolved_at = IF status INSIDE ["pending_review", "closed", "not_applicable"] OR evidence_fingerprint != $evidenceFingerprint THEN NONE ELSE resolved_at END,
          status = IF status INSIDE ["pending_review", "closed", "not_applicable"] OR evidence_fingerprint != $evidenceFingerprint THEN "pending" ELSE status END,
          evidence_fingerprint = $evidenceFingerprint,
          last_seen_at = time::now()
        RETURN AFTER`,
        {
          workbook: toRecordId(input.workbookId), sheet: toRecordId(candidate.sheetId), record: toRecordId(candidate.recordId),
          field: candidate.field, category: candidate.category, ruleKey: candidate.ruleKey, ruleVersion: candidate.ruleVersion,
          explanation: candidate.explanation, evidenceFingerprint: candidate.evidenceFingerprint,
          stableKey, run: toRecordId(runId),
        },
      );
      findings.push(mapFinding(rows[0] ?? {
        id: `data_check_finding:${stableKey}`, category: candidate.category, explanation: candidate.explanation,
        rule_key: candidate.ruleKey, rule_version: candidate.ruleVersion, record: candidate.recordId,
        sheet: candidate.sheetId, field: candidate.field, evidence_fingerprint: candidate.evidenceFingerprint,
      }));
    }

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
              totalCount, findingCount: findings.length, stale, error: null, findings: [...findings], rulesVersion,
            }),
          });
          scannedCount += scan.scannedCount;
          totalCount += scan.scannedCount;
          stale ||= scan.stale;
          const templateKey = typeof sheet.template_sheet_key === "string" ? sheet.template_sheet_key : undefined;
          if (templateKey) scannedByTemplateKey.set(templateKey, {
            sheetKey: templateKey, records: scan.records, readable: true,
          });
          for (const record of scan.records) {
            for (const column of runtime.snapshot.columns) {
              const messages = validateGridFieldValue(record.values[column.key], column);
              for (const explanation of messages) {
                const category = explanation === "必填" ? "required" as const : "format" as const;
                const ruleKey = `${category}:${column.key}`;
                const evidenceFingerprint = importFingerprint({ value: record.values[column.key], explanation });
                await persistFinding({
                  category, explanation, ruleKey, ruleVersion: DATA_CHECK_RULES_VERSION,
                  recordId: record.id, sheetId, field: column.key, evidenceFingerprint,
                  stableEvidence: null,
                });
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
      if (templateRules) {
        const templateFindings = evaluateTemplateCheckRules(templateRules, [...scannedByTemplateKey.values()]);
        for (const finding of templateFindings) {
          const sheetId = sheetIdByTemplateKey.get(finding.sheetKey);
          if (!sheetId) continue;
          await persistFinding({
            category: finding.category,
            explanation: finding.explanation,
            ruleKey: finding.ruleKey,
            ruleVersion: finding.ruleVersion,
            recordId: finding.recordId,
            sheetId,
            field: finding.field,
            evidenceFingerprint: importFingerprint(finding.evidence),
            stableEvidence: finding.groupKey ?? null,
          });
        }
      }
      const status: DataCheckStatus = failedSheets === 0 ? "completed" : failedSheets === selected.length ? "failed" : "partial";
      const snapshot = { id: runId, status, scannedCount, totalCount, findingCount: findings.length, stale, error: errors.join("；") || null, findings, rulesVersion };
      await finishRun(conn, snapshot);
      return snapshot;
    } catch (cause) {
      const cancelled = cause instanceof DOMException && cause.name === "AbortError";
      const snapshot: DataCheckRunSnapshot = {
        id: runId, status: cancelled ? "cancelled" : "failed", scannedCount, totalCount,
        findingCount: findings.length, stale: true, error: cancelled ? "用户已取消" : safeError(cause), findings, rulesVersion,
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
      rulesVersion: String(run.rules_version ?? DATA_CHECK_RULES_VERSION),
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
    ruleVersion: String(row.rule_version ?? DATA_CHECK_RULES_VERSION),
    recordId: recordValueToString(row.record) ?? "", sheetId: recordValueToString(row.sheet) ?? "",
    field: String(row.field ?? ""), evidenceFingerprint: String(row.evidence_fingerprint ?? ""),
    status: normalizeFindingStatus(row.status),
    resolutionReason: row.resolution_reason == null ? null : String(row.resolution_reason),
  };
}

function normalizeFindingStatus(value: unknown): DataCheckFinding["status"] {
  if (value === "processing" || value === "pending_review" || value === "closed" || value === "not_applicable") return value;
  return "pending";
}

async function loadTemplateRules(conn: SurrealConn, workbookId: string) {
  const workbooks = await conn.query<{ template?: unknown }>(
    "SELECT template FROM workbook WHERE id = $workbook LIMIT 1",
    { workbook: toRecordId(workbookId) },
  );
  const templateId = recordValueToString(workbooks[0]?.template);
  if (!templateId) return undefined;
  const templates = await conn.query<Record<string, unknown>>(
    "SELECT sheet_defs, check_rules FROM workbook_template WHERE id = $template LIMIT 1",
    { template: toRecordId(templateId) },
  );
  const template = templates[0];
  if (!template) return undefined;
  const sheets = Array.isArray(template.sheet_defs)
    ? template.sheet_defs.flatMap((value): WorkbookTemplateSheet[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.key !== "string") return [];
        return [{
          key: row.key,
          label: typeof row.label === "string" ? row.label : row.key,
          columnDefs: Array.isArray(row.column_defs) ? row.column_defs as WorkbookTemplateSheet["columnDefs"] : [],
        }];
      })
    : [];
  return parseTemplateCheckRules(template.check_rules, sheets);
}

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
