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
  /**
   * 工作簿「类型」= 它由哪个业务模板生成。底层只存这个不透明的 `workbook_template`
   * record 引用；为空 = 空白工作簿（合法常态，不是草稿）。卡片据此向模板 store
   * 解析图标 / 强调色 / 类型名，不再用字符串硬猜。
   */
  templateRef?: RecordIdString;
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
  /** 随机 key 系统边界；生产环境使用 Web Crypto，集成测试可注入确定序列。 */
  generateKey?: () => string;
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: WorkbooksSnapshot) => void;
};

export type WorkbooksStore = ReturnType<typeof createWorkbooksStore>;

/** 把 `workbook` 记录裁成展示用 {@link WorkbookRow}（剔系统字段，规范化 key）。 */
function recordToWorkbook(rec: Record<string, unknown>): WorkbookRow {
  return {
    id: String(rec.id) as RecordIdString,
    name: typeof rec.name === "string" ? rec.name : "",
    templateRef: rec.template != null ? (String(rec.template) as RecordIdString) : undefined,
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
 * 把「建全部实体表 DDL + 建 workbook + 建全部 sheet」拼成单条多语句
 * SurrealQL，外包 `BEGIN/COMMIT` 保证原子性：任一步失败整体回滚，不留半成品工作簿。
 *
 * - 实体表沿用 006-tables-grid 的 `SCHEMALESS CHANGEFEED 7d` 形态 + created_at/updated_at
 *   系统字段；业务列由 {@link buildSurrealFieldSchema} 生成（与 defineField / 后端模板同口径）。
 *   不带 workspace 字段（db 边界隔离）。
 * - 实体表是动态建的，不在静态模板 schema 里，所以它的 record_activity event 必须在
 *   建表时一并 `DEFINE`（HR-15）：数据行 CREATE → `record.write`、DELETE → `record.delete`
 *   时引擎自动 `CREATE activity_event`，归因由 activity_event.actor 的 DEFAULT
 *   fn::current_user() 负责（010）——前端零埋点。这是 DDL，与建表同一会话（admin）。
 * - workbook / 全部 sheet 用 JS 预生成的 key 显式建 RecordId，使表名能在建表前先算出来。
 * - 表名 / 字段名来自受控来源（randomKey + 固定列定义），不接受用户输入，无注入面；
 *   name / label 等用户值走 $bindings。
 * - 返回的 workbook id 来自预生成 key，不依赖多语句事务的返回值位置。
 */
export type CreateWorkbookOptions = {
  /** 业务列定义；缺省只建一个必填文本 name 列。从模板建时传模板的 column_defs。 */
  columns?: GridColumnDef[];
  /** 工作簿类型 = 由哪个模板生成；写入 workbook.template（option record）。空白工作簿不传。 */
  templateRef?: RecordIdString | string;
  /** 单数据表模板的展示名；空白工作簿默认为 Sheet 1。 */
  sheetLabel?: string;
  /** 模板包的全部数据表；不传时保持旧单表创建语义。 */
  sheets?: TemplateSheetForCreate[];
};

export type TemplateSheetForCreate = {
  label: string;
  columns: GridColumnDef[];
};

export type TemplateForCreate = {
  id: RecordIdString | string;
  defaultName?: string;
  /** 新模板包的首个数据表。 */
  sheet?: TemplateSheetForCreate;
  /** 多数据表模板包的全部数据表。 */
  sheets?: TemplateSheetForCreate[];
  /** 旧调用形状：顶层 column_defs 转换后的字段。 */
  columns?: GridColumnDef[];
};

export function buildCreateWorkbookTransaction(
  name: string,
  options: CreateWorkbookOptions = {},
  generateKey: () => string = randomKey,
): { sql: string; bindings: Record<string, unknown>; workbookId: RecordIdString } {
  const wbKey = generateKey();
  const wbId = `workbook:${wbKey}`;
  const requestedSheets = options.sheets?.length
    ? options.sheets
    : [{
        label: options.sheetLabel?.trim() || "Sheet 1",
        columns: options.columns?.length ? options.columns : [DEFAULT_BLANK_COLUMN],
      }];
  const createdSheets = requestedSheets.map((sheet, index) => {
    const sheetKey = generateKey();
    return {
      ...sheet,
      id: `sheet:${sheetKey}`,
      tableName: requestedSheets.length === 1
        ? entityTableNameForWorkbook(wbKey)
        : `ent_${wbKey}_${sheetKey}`,
      index,
    };
  });

  const sheetSql = createdSheets.map((sheet) => {
    const fieldDdl = sheet.columns
      .map((column) => {
        const fieldSchema = buildSurrealFieldSchema(column);
        return `DEFINE FIELD IF NOT EXISTS ${fieldSchema.fieldName} ON TABLE ${sheet.tableName} TYPE ${fieldSchema.type}${fieldSchema.assert};`;
      })
      .join("\n");
    const bindingSuffix = createdSheets.length === 1 ? "" : String(sheet.index);
    const labelBinding = createdSheets.length === 1 ? "$label" : `$sheetLabel${bindingSuffix}`;
    const tableBinding = createdSheets.length === 1 ? "$tableName" : `$sheetTableName${bindingSuffix}`;
    const columnsBinding = createdSheets.length === 1 ? "$columnDefs" : `$sheetColumnDefs${bindingSuffix}`;
    return `DEFINE TABLE IF NOT EXISTS ${sheet.tableName} SCHEMALESS CHANGEFEED 7d;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${sheet.tableName} TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${sheet.tableName} TYPE datetime VALUE time::now();
${fieldDdl}
DEFINE EVENT OVERWRITE record_activity ON TABLE ${sheet.tableName} WHEN $event = "CREATE" OR $event = "DELETE" THEN { LET $verb = IF $event = "CREATE" { "record.write" } ELSE { "record.delete" }; LET $rec = IF $event = "DELETE" { $before } ELSE { $after }; CREATE activity_event CONTENT { verb: $verb, target_kind: "record", target: $rec.id }; };
CREATE ${sheet.id} CONTENT { workbook: ${wbId}, label: ${labelBinding}, table_name: ${tableBinding}, column_defs: ${columnsBinding} };`;
  }).join("\n");

  // template 引用作为 record id 直接拼进 CREATE CONTENT（受控来源：模板 store 的 id，
  // 经 ASSERT 过的 record id 字符串），无引用时省略该字段 = 空白工作簿。
  const templateClause = options.templateRef ? `, template: ${String(options.templateRef)}` : "";

  const sql = `BEGIN TRANSACTION;
CREATE ${wbId} CONTENT { name: $name, last_opened_sheet: ${createdSheets[0]!.id}${templateClause} };
${sheetSql}
COMMIT TRANSACTION;`;

  const bindings: Record<string, unknown> = { name };
  for (const sheet of createdSheets) {
    const suffix = createdSheets.length === 1 ? "" : String(sheet.index);
    bindings[createdSheets.length === 1 ? "label" : `sheetLabel${suffix}`] = sheet.label.trim() || `Sheet ${sheet.index + 1}`;
    bindings[createdSheets.length === 1 ? "tableName" : `sheetTableName${suffix}`] = sheet.tableName;
    bindings[createdSheets.length === 1 ? "columnDefs" : `sheetColumnDefs${suffix}`] = sheet.columns.map(gridColumnToStoredDef);
  }

  return {
    sql,
    bindings,
    workbookId: wbId as RecordIdString,
  };
}

/** 纯过滤：按 name 大小写不敏感匹配；空 query 返回全部。 */
export function filterWorkbooksByQuery(workbooks: WorkbookRow[], query: string): WorkbookRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return workbooks;
  return workbooks.filter((wb) => wb.name.toLowerCase().includes(q));
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
   * 建工作簿 = 一次事务内建全部实体表（DDL）+ workbook + 全部 sheet，整体原子
   * （{@link buildCreateWorkbookTransaction}）。新工作簿打开即可用，不会出现
   * 「workbook 已建但无 sheet / sheet 指向不存在表」的中间态。
   * DDL/写权限由 access 类型卡死，participant 触发的权限错误翻成中文提示。
   */
  async function create(name: string, options: CreateWorkbookOptions): Promise<WorkbookRow | null> {
    state.error = null;
    const { sql, bindings, workbookId } = buildCreateWorkbookTransaction(
      name,
      options,
      deps.generateKey,
    );
    try {
      await deps.getConn().query(sql, bindings);
    } catch (err) {
      state.error = describeWriteError(err);
      emit();
      return null;
    }
    // 事务成功 = workbook/sheet/实体表都已落库。id 与名字 JS 侧已知，无需回读拼一行
    //（updated_at 由列表下次 load 时补全），避免依赖多语句事务的返回值索引。
    const templateRef = options.templateRef ? (String(options.templateRef) as RecordIdString) : undefined;
    const workbook: WorkbookRow = { id: workbookId, name, templateRef };
    state.workbooks = [workbook, ...state.workbooks];
    emit();
    return workbook;
  }

  /** 空白工作簿：无模板引用 = 无类型（合法常态，卡片显示「空白工作簿」）。 */
  function createBlank(name: string): Promise<WorkbookRow | null> {
    return create(name, {});
  }

  /**
   * 从业务模板新建：工作簿带上 template 引用（= 类型），各实体表按对应 column_defs 建列。
   * 模板的展示元数据（icon / accent / label）不落到 workbook 上，卡片渲染时按
   * templateRef 向模板 store 解析——类型语义只有一份真相，在模板数据里。
   */
  function createFromTemplate(
    template: TemplateForCreate,
    name?: string,
  ): Promise<WorkbookRow | null> {
    const finalName = (name?.trim() || template.defaultName?.trim() || "未命名工作簿");
    return create(finalName, {
      templateRef: template.id,
      sheets: template.sheets,
      columns: template.sheet?.columns ?? template.columns,
      sheetLabel: template.sheet?.label,
    });
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
    createFromTemplate,
    rename,
  };
}
