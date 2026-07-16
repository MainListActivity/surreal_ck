import {
  buildSurrealFieldSchema,
  coerceGridFieldValue,
  gridColumnToStoredDef,
  normalizeGridColumnDef,
  storedColumnToDTO,
  validateGridFieldValue,
  type StoredGridFieldDef,
} from "@surreal-ck/shared/field-schema";
import type {
  GridColumnDef,
  GridRow,
  RecordIdString,
  ViewParams,
} from "@surreal-ck/shared/rpc.types";
import { mapNullsToSurrealNone } from "@surreal-ck/shared/surreal-values";
import {
  buildSelect,
  describeWriteError,
  prepareRecordFields,
  wrapRecordField,
} from "./workbook-data";
import { recordValueToString, toRecordId } from "./record-id";
import type { LiveMessage, SurrealConn } from "./surreal";
import {
  normalizeTemplateImportRows,
  type TemplateImportMapping,
  type TemplateImportRejectedRow,
} from "./template-sheet-import";

const PAGE = { limit: 500, start: 0 } as const;
const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);
const REFRESH_DEBOUNCE_MS = 25;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export type DataTableRuntimeErrorCode =
  | "validation"
  | "permission-denied"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "outcome-unknown"
  | "closed"
  | "unexpected";

export type DataTableRuntimeError = {
  code: DataTableRuntimeErrorCode;
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
};

export type RuntimeResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: DataTableRuntimeError };

export type DraftPromotionResult =
  | { status: "incomplete"; fieldErrors: Record<string, string[]> }
  | { status: "promoted"; record: GridRow }
  | { status: "failed"; error: DataTableRuntimeError };

export type FieldRemovalPlan = {
  token: string;
  fieldKey: string;
  fieldLabel: string;
  affectedRecordCount: number;
  sampleValues: unknown[];
  transientDependencies: string[];
  blockers: Array<{ kind: "dashboard-view" | "unknown"; id: string; label: string }>;
};

export type DataTableRuntimeStatus =
  | "opening"
  | "ready"
  | "refreshing"
  | "closing"
  | "closed"
  | "error";

export type DataTableRuntimeSnapshot = {
  status: DataTableRuntimeStatus;
  dataTableId: RecordIdString;
  label: string;
  columns: GridColumnDef[];
  records: GridRow[];
  query: ViewParams;
  error: DataTableRuntimeError | null;
};

export type OpenDataTableRuntimeInput = {
  conn: SurrealConn;
  workbookId: string;
  dataTableId: string;
  query: ViewParams;
  onChange?: (snapshot: DataTableRuntimeSnapshot) => void;
};

export type ImportCsvRowsInput = {
  rows: string[][];
  rowNumbers?: number[];
  mappings: TemplateImportMapping[];
};

export type ImportCsvRowsResult = {
  importedCount: number;
  rejected: TemplateImportRejectedRow[];
};

type StoredDataTable = {
  id: unknown;
  workbook?: unknown;
  label?: unknown;
  table_name?: unknown;
  column_defs?: StoredGridFieldDef[];
};

type RuntimeMeta = {
  id: RecordIdString;
  label: string;
  tableName: string;
  columns: GridColumnDef[];
};

export type DataTableRuntime = Awaited<ReturnType<typeof openDataTableRuntime>>;

/**
 * 打开一个活动数据表的唯一执行 Module。调用方只提供工作簿 / 数据表标识与查询意图；
 * 真实表名、字段存储形态、记录编解码、LIVE 顺序和 mutation 调度全部留在 Implementation 内。
 */
export async function openDataTableRuntime(input: OpenDataTableRuntimeInput) {
  const { conn } = input;
  const meta = await loadRuntimeMeta(conn, input.workbookId, input.dataTableId);
  let status: DataTableRuntimeStatus = "opening";
  let columns = meta.columns;
  let records: GridRow[] = [];
  let query = cloneView(input.query);
  let error: DataTableRuntimeError | null = null;
  let unsubscribeLive: (() => void) | null = null;
  let liveBuffer: LiveMessage[] = [];
  let bufferingLive = true;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let schemaTail: Promise<unknown> = Promise.resolve();
  const recordTails = new Map<string, Promise<unknown>>();
  const removalPlans = new Map<string, FieldRemovalPlan & { schemaFingerprint: string }>();

  function snapshot(): DataTableRuntimeSnapshot {
    return {
      status,
      dataTableId: meta.id,
      label: meta.label,
      columns: columns.map(cloneColumn),
      records: records.map(cloneRow),
      query: cloneView(query),
      error: error ? { ...error, fieldErrors: cloneFieldErrors(error.fieldErrors) } : null,
    };
  }

  function emit(): void {
    input.onChange?.(snapshot());
  }

  function ensureOpen(): RuntimeResult<void> | null {
    if (status !== "closing" && status !== "closed") return null;
    return { ok: false, error: runtimeError("closed", "数据表运行时已关闭", false) };
  }

  async function queryRecords(): Promise<GridRow[]> {
    const built = buildSelect(meta.tableName, query, columns, PAGE);
    const raw = await conn.query<Record<string, unknown>>(built.sql, built.bindings);
    return raw.map((record) => recordToGrid(record, columns));
  }

  function applySafeLive(message: LiveMessage): boolean {
    const id = String(message.value.id);
    const index = records.findIndex((record) => record.id === id);
    if (message.action === "DELETE") {
      if (index !== -1) records = records.filter((record) => record.id !== id);
      // 删除可能需要从下一页补一条，窗口不再可证明完整。
      return false;
    }
    if (message.action !== "CREATE" && message.action !== "UPDATE") return false;
    if (index === -1) {
      // 无筛选/排序/分组且首窗未满时，新记录必然属于当前窗口，可安全追加。
      if (message.action === "CREATE" && queryDependencyKeys(query).size === 0 && records.length < PAGE.limit) {
        records = [...records, recordToGrid(message.value, columns)];
        return true;
      }
      return false;
    }

    const next = recordToGrid(message.value, columns);
    const previous = records[index];
    const dependencies = queryDependencyKeys(query);
    if ([...dependencies].some((key) => !sameValue(previous.values[key], next.values[key]))) {
      return false;
    }
    records = records.map((record) => (record.id === id ? next : record));
    return true;
  }

  function onLive(message: LiveMessage): void {
    if (status === "closing" || status === "closed") return;
    if (bufferingLive || status === "refreshing") {
      liveBuffer.push(message);
      return;
    }
    const before = records;
    if (applySafeLive(message)) {
      emit();
      return;
    }
    // DELETE 可立即从窗口移除，但仍需重查补齐分页边缘。
    if (records !== before) emit();
    scheduleRefresh();
  }

  function scheduleRefresh(): void {
    if (status === "closing" || status === "closed" || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function refresh(): Promise<void> {
    const closed = ensureOpen();
    if (closed || refreshPromise) return refreshPromise ?? undefined;
    refreshPromise = (async () => {
      status = "refreshing";
      error = null;
      bufferingLive = true;
      emit();
      try {
        records = await queryRecords();
        const receivedDuringQuery = liveBuffer.length > 0;
        liveBuffer = [];
        // 若查询期间发生变化，再查一次即可取得这些变化后的权威窗口；第二次查询期间
        // 的事件继续缓冲，完成后按安全规则合并，无法证明安全则排下一次防抖刷新。
        if (receivedDuringQuery) records = await queryRecords();
        const tail = liveBuffer;
        liveBuffer = [];
        bufferingLive = false;
        status = "ready";
        for (const message of tail) {
          if (!applySafeLive(message)) scheduleRefresh();
        }
      } catch (cause) {
        error = classifyError(cause);
        status = "error";
      } finally {
        emit();
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function integrateReturnedRecord(record: GridRow, previous?: GridRow): void {
    const dependencies = queryDependencyKeys(query);
    const safe = previous
      && records.some((item) => item.id === previous.id)
      && [...dependencies].every((key) => sameValue(previous.values[key], record.values[key]));
    if (safe) {
      records = records.map((item) => (item.id === record.id ? record : item));
      emit();
    } else {
      scheduleRefresh();
    }
  }

  function runRecordMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = recordTails.get(key) ?? Promise.resolve();
    const current = schemaTail
      .catch(() => undefined)
      .then(() => previous.catch(() => undefined))
      .then(operation);
    const settled = current.finally(() => {
      if (recordTails.get(key) === settled) recordTails.delete(key);
    });
    recordTails.set(key, settled);
    return current;
  }

  function runSchemaMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = schemaTail
      .catch(() => undefined)
      .then(() => Promise.allSettled([...recordTails.values()]))
      .then(operation);
    schemaTail = current.catch(() => undefined);
    return current;
  }

  async function updateRecords(
    patches: Array<{ id: RecordIdString; values: Record<string, unknown> }>,
  ): Promise<RuntimeResult<GridRow[]>> {
    const closed = ensureOpen();
    if (closed) return closed as RuntimeResult<GridRow[]>;
    const results = await Promise.all(patches.map((patch) => runRecordMutation(patch.id, async () => {
      const previous = records.find((record) => record.id === patch.id);
      if (!previous) {
        return { ok: false, error: runtimeError("not-found", `记录不存在: ${patch.id}`, false) } as RuntimeResult<GridRow>;
      }
      const unknownKeys = Object.keys(patch.values).filter((key) =>
        !columns.some((column) => column.key === key));
      if (unknownKeys.length) {
        return {
          ok: false,
          error: runtimeError(
            "validation",
            `记录包含未知字段: ${unknownKeys.join(", ")}`,
            false,
            Object.fromEntries(unknownKeys.map((key) => [key, ["字段不存在"]])),
          ),
        } as RuntimeResult<GridRow>;
      }
      const requested = coercePatchValues(patch.values, columns);
      const changed = changedValues(previous.values, requested);
      if (!Object.keys(changed).length) return { ok: true, value: previous } as RuntimeResult<GridRow>;
      const validation = validateValues({ ...previous.values, ...changed }, columns);
      if (Object.keys(validation).length) {
        return {
          ok: false,
          error: runtimeError("validation", "记录未通过字段校验", false, validation),
        } as RuntimeResult<GridRow>;
      }
      try {
        const prepared = prepareRecordPatch(changed, columns);
        const raw = await conn.updateRecord<Record<string, unknown>>(
          patch.id,
          mapNullsToSurrealNone(prepared),
        );
        const mergedRaw = { id: patch.id, ...previous.values, ...changed, ...raw };
        const updated = recordToGrid(mergedRaw, columns);
        integrateReturnedRecord(updated, previous);
        return { ok: true, value: updated } as RuntimeResult<GridRow>;
      } catch (cause) {
        return { ok: false, error: classifyError(cause) } as RuntimeResult<GridRow>;
      }
    })));
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) return failure;
    return { ok: true, value: results.flatMap((result) => result.ok ? [result.value] : []) };
  }

  async function promoteDraft(values: Record<string, unknown>): Promise<DraftPromotionResult> {
    const closed = ensureOpen();
    if (closed && !closed.ok) return { status: "failed", error: closed.error };
    const coerced = coerceValues(values, columns);
    const fieldErrors = validateValues(coerced, columns);
    if (Object.keys(fieldErrors).length) return { status: "incomplete", fieldErrors };
    return runRecordMutation(`create:${crypto.randomUUID()}`, async () => {
      try {
        const raw = await conn.createRecord<Record<string, unknown>>(
          meta.tableName,
          prepareRecordFields(coerced, columns),
        );
        const created = recordToGrid(raw, columns);
        integrateReturnedRecord(created);
        return { status: "promoted", record: created } as DraftPromotionResult;
      } catch (cause) {
        return { status: "failed", error: classifyError(cause) } as DraftPromotionResult;
      }
    });
  }

  async function importCsvRows(input: ImportCsvRowsInput): Promise<ImportCsvRowsResult> {
    const closed = ensureOpen();
    if (closed) {
      return {
        importedCount: 0,
        rejected: input.rows.map((sourceCells, index) => ({
          rowNumber: input.rowNumbers?.[index] ?? index + 2,
          field: "整条记录",
          reason: closed.ok ? "数据表运行时已关闭" : closed.error.message,
          sourceCells: [...sourceCells],
        })),
      };
    }

    const mappedKeys = new Set(input.mappings.flatMap((mapping) =>
      mapping.targetKey ? [mapping.targetKey] : []));
    const referenceMatches = new Map<string, Map<string, string[]>>();
    for (const column of columns) {
      if (column.fieldType !== "reference" || !mappedKeys.has(column.key)) continue;
      if (!column.referenceTable || !column.referenceDisplayKey) continue;
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT id, ${column.referenceDisplayKey} FROM ${column.referenceTable}`,
      );
      const matches = new Map<string, string[]>();
      for (const row of rows) {
        const displayValue = row[column.referenceDisplayKey];
        if (displayValue == null) continue;
        const key = relaxedImportText(String(displayValue));
        matches.set(key, [...(matches.get(key) ?? []), String(row.id)]);
      }
      referenceMatches.set(column.key, matches);
    }

    const normalized = normalizeTemplateImportRows({
      rows: input.rows,
      rowNumbers: input.rowNumbers,
      mappings: input.mappings,
      targets: columns.map((column) => ({ column })),
      referenceMatches,
    });
    const rejected = [...normalized.rejected];
    let importedCount = 0;
    for (const record of normalized.records) {
      try {
        const raw = await runRecordMutation(`import:${record.rowNumber}:${crypto.randomUUID()}`, () =>
          conn.createRecord<Record<string, unknown>>(
            meta.tableName,
            prepareRecordFields(record.values, columns),
          ));
        integrateReturnedRecord(recordToGrid(raw, columns));
        importedCount += 1;
      } catch (cause) {
        rejected.push({
          rowNumber: record.rowNumber,
          field: "整条记录",
          reason: classifyError(cause).message,
          sourceCells: record.sourceCells,
        });
      }
    }
    return { importedCount, rejected };
  }

  async function deleteRecords(ids: Array<RecordIdString | string>): Promise<RuntimeResult<void>> {
    const closed = ensureOpen();
    if (closed) return closed;
    try {
      await Promise.all(ids.map((id) => runRecordMutation(String(id), async () => {
        await conn.deleteRecord(String(id));
        records = records.filter((record) => record.id !== String(id));
      })));
      emit();
      scheduleRefresh();
      return { ok: true, value: undefined };
    } catch (cause) {
      return { ok: false, error: classifyError(cause) };
    }
  }

  async function performFieldUpdate(
    nextColumns: GridColumnDef[],
    confirmedRemovals: ReadonlyMap<string, number>,
  ): Promise<RuntimeResult<GridColumnDef[]>> {
    const closed = ensureOpen();
    if (closed) return closed as RuntimeResult<GridColumnDef[]>;
    return runSchemaMutation(async () => {
      if (!nextColumns.length) {
        return { ok: false, error: runtimeError("validation", "至少保留一个字段", false) };
      }
      let normalized: GridColumnDef[];
      try {
        normalized = nextColumns.map(normalizeGridColumnDef);
      } catch (cause) {
        return { ok: false, error: runtimeError("validation", String(cause), false) };
      }
      const seen = new Set<string>();
      for (const column of normalized) {
        if (seen.has(column.key)) {
          return { ok: false, error: runtimeError("validation", `字段标识重复: ${column.key}`, false) };
        }
        seen.add(column.key);
      }
      const oldKeys = new Set(columns.map((column) => column.key));
      const added = normalized.filter((column) => !oldKeys.has(column.key));
      const removed = columns.filter((column) => !seen.has(column.key));
      // 同一次普通编辑同时删旧 key / 加新 key，高概率是修改字段标识；强制走字段迁移。
      if (added.length && removed.length) {
        return {
          ok: false,
          error: runtimeError("conflict", "字段标识创建后不可修改；请使用独立字段迁移", false),
        };
      }
      const unconfirmedRemoval = removed.find((column) => !confirmedRemovals.has(column.key));
      if (unconfirmedRemoval) {
        return {
          ok: false,
          error: runtimeError("conflict", `字段「${unconfirmedRemoval.label}」删除前必须完成预检与确认`, false),
        };
      }

      try {
        await conn.transaction(async (tx) => {
          const allRows = await tx.query<Record<string, unknown>>(`SELECT * FROM ${meta.tableName}`);
          const changedRemoval = removed.find((column) =>
            allRows.filter((row) => row[column.key] !== undefined && row[column.key] !== null).length
              !== confirmedRemovals.get(column.key));
          if (changedRemoval) {
            throw new RuntimeConflictError(`字段「${changedRemoval.label}」的数据已变化，请重新预检`);
          }
          const compatibility = validateExistingRows(allRows, columns, normalized);
          if (compatibility) throw new RuntimeConflictError(compatibility);
          if (removed.length) {
            const dashboards = await tx.query<Record<string, unknown>>(
              "SELECT id, title, widgets FROM dashboard_page",
            );
            const blocked = removed.find((column) => dashboards.some((dashboard) =>
              dashboardDependsOnField(dashboard, meta.tableName, column.key)));
            if (blocked) {
              throw new RuntimeConflictError(`字段「${blocked.label}」仍被持久化仪表盘视图依赖`);
            }
          }

          for (const column of normalized) {
            const schema = buildSurrealFieldSchema(column);
            await tx.query(
              `DEFINE FIELD OVERWRITE ${schema.fieldName} ON TABLE ${meta.tableName} TYPE ${schema.type}${schema.assert}`,
            );
          }
          for (const column of removed) {
            await tx.query(`UPDATE ${meta.tableName} UNSET ${column.key}`);
            await tx.query(`REMOVE FIELD IF EXISTS ${column.key} ON TABLE ${meta.tableName}`);
          }
          await tx.updateRecord(meta.id, {
            column_defs: normalized.map(gridColumnToStoredDef),
          });
        });
        columns = normalized;
        records = records.map((record) => recordToGrid(
          { id: record.id, ...record.values },
          columns,
        ));
        query = pruneQuery(query, new Set(columns.map((column) => column.key)));
        emit();
        scheduleRefresh();
        return { ok: true, value: columns.map(cloneColumn) };
      } catch (cause) {
        if (cause instanceof RuntimeConflictError) {
          return { ok: false, error: runtimeError("conflict", cause.message, false) };
        }
        return { ok: false, error: classifyError(cause) };
      }
    });
  }

  function updateFields(nextColumns: GridColumnDef[]): Promise<RuntimeResult<GridColumnDef[]>> {
    return performFieldUpdate(nextColumns, new Map());
  }

  async function planFieldRemoval(fieldKey: string): Promise<RuntimeResult<FieldRemovalPlan>> {
    const closed = ensureOpen();
    if (closed) return closed as RuntimeResult<FieldRemovalPlan>;
    const column = columns.find((candidate) => candidate.key === fieldKey);
    if (!column) return { ok: false, error: runtimeError("not-found", `字段不存在: ${fieldKey}`, false) };
    if (columns.length <= 1) {
      return { ok: false, error: runtimeError("validation", "至少保留一个字段", false) };
    }
    try {
      const [allRows, dashboardRows] = await Promise.all([
        conn.query<Record<string, unknown>>(`SELECT * FROM ${meta.tableName}`),
        conn.query<Record<string, unknown>>("SELECT id, title, widgets FROM dashboard_page"),
      ]);
      const affected = allRows.filter((row) => row[fieldKey] !== undefined && row[fieldKey] !== null);
      const blockers = dashboardRows.flatMap((row) => dashboardDependsOnField(row, meta.tableName, fieldKey)
        ? [{
            kind: "dashboard-view" as const,
            id: String(row.id),
            label: typeof row.title === "string" ? row.title : String(row.id),
          }]
        : []);
      const transientDependencies: string[] = [];
      if ((query.filters ?? []).some((item) => item.key === fieldKey)) transientDependencies.push("filter");
      if ((query.sorts ?? []).some((item) => item.key === fieldKey)) transientDependencies.push("sort");
      if (query.groupBy === fieldKey) transientDependencies.push("group");
      const plan: FieldRemovalPlan & { schemaFingerprint: string } = {
        token: crypto.randomUUID(),
        fieldKey,
        fieldLabel: column.label,
        affectedRecordCount: affected.length,
        sampleValues: affected.slice(0, 3).map((row) => recordValueToString(row[fieldKey])),
        transientDependencies,
        blockers,
        schemaFingerprint: JSON.stringify(columns),
      };
      removalPlans.set(plan.token, plan);
      const { schemaFingerprint: _, ...publicPlan } = plan;
      return { ok: true, value: publicPlan };
    } catch (cause) {
      return { ok: false, error: classifyError(cause) };
    }
  }

  async function confirmFieldRemoval(token: string): Promise<RuntimeResult<GridColumnDef[]>> {
    const closed = ensureOpen();
    if (closed) return closed as RuntimeResult<GridColumnDef[]>;
    const plan = removalPlans.get(token);
    removalPlans.delete(token);
    if (!plan || plan.schemaFingerprint !== JSON.stringify(columns)) {
      return { ok: false, error: runtimeError("conflict", "字段删除预检已过期，请重新检查", false) };
    }
    if (plan.blockers.length) {
      return {
        ok: false,
        error: runtimeError("conflict", `字段仍被 ${plan.blockers.length} 个持久化视图依赖`, false),
      };
    }
    return performFieldUpdate(
      columns.filter((column) => column.key !== plan.fieldKey),
      new Map([[plan.fieldKey, plan.affectedRecordCount]]),
    );
  }

  async function setQuery(next: ViewParams): Promise<RuntimeResult<void>> {
    const closed = ensureOpen();
    if (closed) return closed;
    query = cloneView(next);
    await refresh();
    return error ? { ok: false, error } : { ok: true, value: undefined };
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (status === "closed") return;
      status = "closing";
      emit();
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      unsubscribeLive?.();
      unsubscribeLive = null;
      await Promise.allSettled([schemaTail, ...recordTails.values()]);
      status = "closed";
      emit();
    })();
    return closePromise;
  }

  // 先建立 LIVE 并缓冲，再查询快照，消除 load→subscribe 变更窗口。
  unsubscribeLive = await conn.liveTable(meta.tableName, onLive);
  await refresh();
  const openedSnapshot = snapshot();
  if (openedSnapshot.status === "error") {
    unsubscribeLive?.();
    unsubscribeLive = null;
    status = "closed";
    throw new Error(openedSnapshot.error?.message ?? "数据表运行时打开失败");
  }

  return {
    get snapshot() { return snapshot(); },
    setQuery,
    refresh,
    updateRecords,
    promoteDraft,
    importCsvRows,
    deleteRecords,
    updateFields,
    planFieldRemoval,
    confirmFieldRemoval,
    close,
  };
}

function relaxedImportText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, "");
}

async function loadRuntimeMeta(
  conn: SurrealConn,
  workbookId: string,
  dataTableId: string,
): Promise<RuntimeMeta> {
  const rows = await conn.query<StoredDataTable>(
    "SELECT * FROM sheet WHERE id = $dataTable AND workbook = $workbook",
    { dataTable: toRecordId(dataTableId), workbook: toRecordId(workbookId) },
  );
  const row = rows[0];
  if (!row || typeof row.table_name !== "string" || !row.table_name) {
    throw new Error("数据表不存在或不属于当前工作簿");
  }
  if (!SAFE_IDENTIFIER.test(row.table_name)) {
    throw new Error("数据表物理标识无效");
  }
  const columns = (row.column_defs ?? []).map(storedColumnToDTO);
  const seen = new Set<string>();
  for (const column of columns) {
    // 既校验 DDL 标识符，也校验 field type / reference target 等持久化 schema。
    buildSurrealFieldSchema(column);
    if (seen.has(column.key)) throw new Error(`数据表字段标识重复: ${column.key}`);
    seen.add(column.key);
  }
  return {
    id: String(row.id) as RecordIdString,
    label: typeof row.label === "string" ? row.label : "",
    tableName: row.table_name,
    columns,
  };
}

function recordToGrid(record: Record<string, unknown>, columns: GridColumnDef[]): GridRow {
  const known = new Set(columns.map((column) => column.key));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(key) || !known.has(key)) continue;
    values[key] = recordValueToString(value);
  }
  return { id: String(record.id) as RecordIdString, values };
}

function validateValues(
  values: Record<string, unknown>,
  columns: GridColumnDef[],
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const column of columns) {
    const fieldErrors = validateGridFieldValue(values[column.key], column);
    if (fieldErrors.length) errors[column.key] = fieldErrors;
  }
  return errors;
}

function coerceValues(values: Record<string, unknown>, columns: GridColumnDef[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [
    column.key,
    coerceGridFieldValue(values[column.key], column),
  ]));
}

function coercePatchValues(
  values: Record<string, unknown>,
  columns: GridColumnDef[],
): Record<string, unknown> {
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const column = columnByKey.get(key);
    return [key, column ? coerceGridFieldValue(value, column) : value];
  }));
}

/** UPDATE 必须保留 null，再在 SDK 边界映射为 NONE；create 才省略 nullish。 */
function prepareRecordPatch(
  values: Record<string, unknown>,
  columns: GridColumnDef[],
): Record<string, unknown> {
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const column = columnByKey.get(key);
    return [key, column ? wrapRecordField(value, column) : value];
  }));
}

function changedValues(
  previous: Record<string, unknown>,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(requested).filter(([key, value]) => !sameValue(previous[key], value)));
}

function validateExistingRows(
  rows: Record<string, unknown>[],
  previousColumns: GridColumnDef[],
  nextColumns: GridColumnDef[],
): string | null {
  const previousByKey = new Map(previousColumns.map((column) => [column.key, column]));
  for (const column of nextColumns) {
    const previous = previousByKey.get(column.key);
    for (const row of rows) {
      const raw = recordValueToString(row[column.key]);
      if (raw == null && !column.required) continue;
      if (previous && storageFamily(previous) !== storageFamily(column) && !strictlyMatches(raw, column)) {
        return `字段「${column.label}」存在不兼容值，普通字段编辑不会自动转换业务数据`;
      }
      const errors = validateGridFieldValue(raw, column);
      if (errors.length) return `字段「${column.label}」存在不兼容值：${errors[0]}`;
    }
  }
  return null;
}

function storageFamily(column: GridColumnDef): string {
  if (column.fieldType === "text" || column.fieldType === "single_select") return "string";
  if (column.fieldType === "number" || column.fieldType === "decimal") return "number";
  return column.fieldType;
}

function strictlyMatches(value: unknown, column: GridColumnDef): boolean {
  if (value == null) return !column.required;
  switch (storageFamily(column)) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "checkbox": return typeof value === "boolean";
    case "date": return value instanceof Date || !Number.isNaN(new Date(String(value)).getTime());
    case "reference": return typeof value === "string" && value.includes(":");
    default: return false;
  }
}

function queryDependencyKeys(view: ViewParams): Set<string> {
  return new Set([
    ...(view.filters ?? []).map((filter) => filter.key),
    ...(view.sorts ?? []).map((sort) => sort.key),
    ...(view.groupBy ? [view.groupBy] : []),
  ]);
}

function pruneQuery(view: ViewParams, known: Set<string>): ViewParams {
  return {
    ...cloneView(view),
    filters: (view.filters ?? []).filter((filter) => known.has(filter.key)),
    sorts: (view.sorts ?? []).filter((sort) => known.has(sort.key)),
    hiddenFields: (view.hiddenFields ?? []).filter((key) => known.has(key)),
    groupBy: view.groupBy && known.has(view.groupBy) ? view.groupBy : null,
  };
}

function cloneView(view: ViewParams): ViewParams {
  return {
    ...view,
    filters: [...(view.filters ?? [])],
    sorts: [...(view.sorts ?? [])],
    hiddenFields: [...(view.hiddenFields ?? [])],
  };
}

function cloneColumn(column: GridColumnDef): GridColumnDef {
  return {
    ...column,
    options: column.options ? [...column.options] : undefined,
    constraints: column.constraints ? { ...column.constraints } : undefined,
  };
}

function cloneRow(row: GridRow): GridRow {
  return { id: row.id, values: { ...row.values } };
}

function cloneFieldErrors(errors?: Record<string, string[]>): Record<string, string[]> | undefined {
  return errors ? Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, [...value]])) : undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

/** 已知 dashboard widget spec 的保守依赖扫描；无法解析的结构不在此自动级联处理。 */
function dashboardDependsOnField(
  dashboard: Record<string, unknown>,
  tableName: string,
  fieldKey: string,
): boolean {
  const widgets = Array.isArray(dashboard.widgets) ? dashboard.widgets : [];
  return widgets.some((widget) => {
    if (!widget || typeof widget !== "object") return false;
    const spec = (widget as { spec?: unknown }).spec;
    if (!spec || typeof spec !== "object") return false;
    const sourceTables = (spec as { sourceTables?: unknown }).sourceTables;
    if (!Array.isArray(sourceTables) || !sourceTables.includes(tableName)) return false;
    return objectContainsExactValue(spec, fieldKey);
  });
}

function objectContainsExactValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => objectContainsExactValue(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => objectContainsExactValue(item, expected));
}

function runtimeError(
  code: DataTableRuntimeErrorCode,
  message: string,
  retryable: boolean,
  fieldErrors?: Record<string, string[]>,
): DataTableRuntimeError {
  return { code, message, retryable, ...(fieldErrors ? { fieldErrors } : {}) };
}

function classifyError(cause: unknown): DataTableRuntimeError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/permission|not allowed|IAM/i.test(message)) {
    return runtimeError("permission-denied", describeWriteError(cause), false);
  }
  if (/not found|does not exist|不存在/i.test(message)) return runtimeError("not-found", message, false);
  if (/disconnect|socket|network|timeout|closed/i.test(message)) return runtimeError("unavailable", message, true);
  return runtimeError("unexpected", message, false);
}

class RuntimeConflictError extends Error {}
