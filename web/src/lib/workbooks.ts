import { buildSurrealFieldSchema, gridColumnToStoredDef } from "@surreal-ck/shared/field-schema";
import type { GridColumnDef, RecordIdString } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import { describeWriteError } from "./workbook-data";

/**
 * workbook 列表项——直连读 `workbook` 表的裁剪形态。
 *
 * 新模型下 workbook 表不带 workspace 字段（跨 workspace 隔离靠 db 边界），也没有
 * folder 表，所以这里**不**带 workspaceId / folderId。「最近打开」等 scope 信息属于
 * 后端 Workspace Scope Module，不塞进 workbook 表。
 */
export type WorkbookRow = {
  id: RecordIdString;
  name: string;
  templateKey?: string;
  updatedAt?: string;
  createdBy?: string;
};

export type WorkbooksState = {
  loading: boolean;
  error: string | null;
  workbooks: WorkbookRow[];
};

export type WorkbooksSnapshot = WorkbooksState;

export type WorkbooksDeps = {
  getConn: () => SurrealConn;
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: WorkbooksSnapshot) => void;
};

export type WorkbooksStore = ReturnType<typeof createWorkbooksStore>;

/** 把 `workbook` 记录裁成展示用 {@link WorkbookRow}（剔系统字段，规范化 key）。 */
function recordToWorkbook(rec: Record<string, unknown>): WorkbookRow {
  return {
    id: String(rec.id) as RecordIdString,
    name: typeof rec.name === "string" ? rec.name : "",
    templateKey: typeof rec.template_key === "string" ? rec.template_key : undefined,
    updatedAt: typeof rec.updated_at === "string" ? rec.updated_at : undefined,
    createdBy: rec.created_by || rec.owner_user ? String(rec.created_by ?? rec.owner_user) : undefined,
  };
}

/** 新建空白工作簿的默认列：仅一个必填文本 name 列。用户后续自行 addField 扩展。 */
const DEFAULT_BLANK_COLUMN: GridColumnDef = {
  key: "name",
  label: "名称",
  fieldType: "text",
  required: true,
};

/**
 * 16 位 hex 随机 key，用于 workbook / sheet 的 RecordId 以及推导实体表名。
 * 浏览器侧没有 Bun.hash，用 crypto 随机数即可——不需要确定性，只要唯一且是合法 record id。
 */
function randomKey(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 由 workbook key 推导实体表名 `ent_<wbKey>_main`。
 * 新模型下跨 workspace 隔离靠 db 边界，表名不再带 workspace 前缀（对比 legacy
 * generateEntityTableName 的 `ent_<wsKey>_<wbKey>`）；唯一性由 wbKey 保证。
 */
export function entityTableNameForWorkbook(wbKey: string): string {
  return `ent_${wbKey}_main`;
}

/**
 * 把「建实体表 DDL + 建 workbook + 建 sheet」拼成单条多语句 SurrealQL，外包
 * `BEGIN/COMMIT` 保证三步原子：任一步失败整体回滚，绝不留下指向不存在表的孤儿 sheet。
 *
 * - 实体表沿用 006-tables-grid 的 `SCHEMALESS CHANGEFEED 7d` 形态 + created_at/updated_at
 *   系统字段；业务列由 {@link buildSurrealFieldSchema} 生成（与 defineField / 后端模板同口径）。
 *   不带 workspace 字段（db 边界隔离）。
 * - workbook / sheet 用 JS 预生成的 key 显式建 RecordId，使表名能在建表前先算出来。
 * - 表名 / 字段名来自受控来源（randomKey + 固定列定义），不接受用户输入，无注入面；
 *   name / label 等用户值走 $bindings。
 * - 末句 `RETURN`（事务外）回读新 workbook，供调用方裁成 WorkbookRow。
 */
export function buildCreateWorkbookTransaction(
  name: string,
  column: GridColumnDef = DEFAULT_BLANK_COLUMN,
): { sql: string; bindings: Record<string, unknown>; workbookId: RecordIdString } {
  const wbKey = randomKey();
  const sheetKey = randomKey();
  const tableName = entityTableNameForWorkbook(wbKey);
  const wbId = `workbook:${wbKey}`;
  const sheetId = `sheet:${sheetKey}`;

  const fieldSchema = buildSurrealFieldSchema(column);

  const sql = `BEGIN TRANSACTION;
DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS CHANGEFEED 7d;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS ${fieldSchema.fieldName} ON TABLE ${tableName} TYPE ${fieldSchema.type}${fieldSchema.assert};
CREATE ${wbId} CONTENT { name: $name, last_opened_sheet: ${sheetId} };
CREATE ${sheetId} CONTENT { workbook: ${wbId}, label: $label, table_name: $tableName, column_defs: $columnDefs };
COMMIT TRANSACTION;`;

  return {
    sql,
    bindings: {
      name,
      label: "Sheet 1",
      tableName,
      columnDefs: [gridColumnToStoredDef(column)],
    },
    workbookId: wbId as RecordIdString,
  };
}

/** 纯过滤：按 name / templateKey 大小写不敏感匹配；空 query 返回全部。 */
export function filterWorkbooksByQuery(workbooks: WorkbookRow[], query: string): WorkbookRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return workbooks;
  return workbooks.filter(
    (wb) => wb.name.toLowerCase().includes(q) || (wb.templateKey ?? "").toLowerCase().includes(q),
  );
}

/**
 * 直连 `workbook` 表的工作簿导航 store（纯逻辑工厂；runes 镜像在 workbooks.svelte.ts）。
 *
 * 读：`SELECT * FROM workbook ORDER BY updated_at DESC`——跨 workspace 隔离由 db 边界保证，
 *     行级权限由表 PERMISSIONS 兜底，查询不带任何鉴权过滤。
 * 写：create / rename 走 createRecord / updateRecord——DDL/写权限由 access 类型卡死，
 *     participant 触发的权限错误经 {@link describeWriteError} 翻成中文提示。
 */
export function createWorkbooksStore(deps: WorkbooksDeps) {
  const state: WorkbooksState = {
    loading: false,
    error: null,
    workbooks: [],
  };

  function emit(): void {
    deps.onChange?.({ loading: state.loading, error: state.error, workbooks: state.workbooks });
  }

  async function load(): Promise<void> {
    state.loading = true;
    state.error = null;
    emit();
    try {
      const records = await deps
        .getConn()
        .query<Record<string, unknown>>("SELECT * FROM workbook ORDER BY updated_at DESC");
      state.workbooks = records.map(recordToWorkbook);
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  /**
   * 建空白工作簿 = 一次事务内建实体表（DDL）+ workbook + 一张默认 sheet，
   * 三者原子（{@link buildCreateWorkbookTransaction}）。新工作簿打开即可用，
   * 不会出现「workbook 已建但无 sheet / sheet 指向不存在表」的中间态。
   * DDL/写权限由 access 类型卡死，participant 触发的权限错误翻成中文提示。
   */
  async function createBlank(name: string): Promise<WorkbookRow | null> {
    state.error = null;
    const { sql, bindings, workbookId } = buildCreateWorkbookTransaction(name);
    try {
      await deps.getConn().query(sql, bindings);
    } catch (err) {
      state.error = describeWriteError(err);
      emit();
      return null;
    }
    // 事务成功 = workbook/sheet/实体表都已落库。id 与名字 JS 侧已知，无需回读拼一行
    //（updated_at 由列表下次 load 时补全），避免依赖多语句事务的返回值索引。
    const workbook: WorkbookRow = { id: workbookId, name };
    state.workbooks = [workbook, ...state.workbooks];
    emit();
    return workbook;
  }

  async function rename(id: RecordIdString | string, name: string): Promise<boolean> {
    state.error = null;
    try {
      await deps.getConn().updateRecord(String(id), { name });
      state.workbooks = state.workbooks.map((wb) => (wb.id === id ? { ...wb, name } : wb));
      emit();
      return true;
    } catch (err) {
      state.error = describeWriteError(err);
      emit();
      return false;
    }
  }

  return {
    get loading(): boolean { return state.loading; },
    get error(): string | null { return state.error; },
    get workbooks(): WorkbookRow[] { return state.workbooks; },
    load,
    createBlank,
    rename,
  };
}
