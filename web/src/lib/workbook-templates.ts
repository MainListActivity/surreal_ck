import { storedColumnToDTO, type StoredGridFieldDef } from "@surreal-ck/shared/field-schema";
import type {
  GridColumnDef,
  RecordIdString,
  WorkbookTemplate,
  WorkbookTemplateFieldDef,
  WorkbookTemplateSheet,
} from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import type { TemplateSheetForCreate } from "./workbooks";

/**
 * 工作簿「类型」= 业务模板的产物。模板是 workspace 内 `workbook_template` 表的数据行，
 * 前端直连读它拿展示元数据（icon / accent / label）与列定义。底层不枚举行业类型，
 * 新增类型 = 多一行数据；跨 workspace 隔离靠 db 边界，查询不带鉴权过滤（PERMISSIONS 兜底）。
 */
export type WorkbookTemplatesState = {
  loading: boolean;
  error: string | null;
  templates: WorkbookTemplate[];
};

export type WorkbookTemplatesSnapshot = WorkbookTemplatesState;

export type WorkbookTemplatesDeps = {
  getConn: () => SurrealConn;
  onChange?: (snapshot: WorkbookTemplatesSnapshot) => void;
};

export type WorkbookTemplatesStore = ReturnType<typeof createWorkbookTemplatesStore>;

function recordToTemplateSheet(value: unknown): WorkbookTemplateSheet | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.key !== "string" || typeof rec.label !== "string") return null;

  return {
    key: rec.key,
    label: rec.label,
    columnDefs: Array.isArray(rec.column_defs)
      ? (rec.column_defs as WorkbookTemplateFieldDef[])
      : [],
  };
}

/** 把 `workbook_template` 记录裁成展示用 {@link WorkbookTemplate}（snake_case → camelCase）。 */
export function recordToTemplate(rec: Record<string, unknown>): WorkbookTemplate {
  const rawDefs = Array.isArray(rec.column_defs) ? (rec.column_defs as StoredGridFieldDef[]) : [];
  const sheets = Array.isArray(rec.sheet_defs)
    ? rec.sheet_defs.map(recordToTemplateSheet).filter((sheet): sheet is WorkbookTemplateSheet => sheet !== null)
    : [];
  return {
    id: String(rec.id) as RecordIdString,
    key: typeof rec.key === "string" ? rec.key : "",
    label: typeof rec.label === "string" ? rec.label : "",
    description: typeof rec.description === "string" ? rec.description : undefined,
    icon: typeof rec.icon === "string" ? rec.icon : undefined,
    accent: typeof rec.accent === "string" ? rec.accent : undefined,
    defaultName: typeof rec.default_name === "string" ? rec.default_name : undefined,
    columnDefs: rawDefs,
    sheets,
    builtin: rec.builtin === true,
    sortOrder: typeof rec.sort_order === "number" ? rec.sort_order : 0,
  };
}

/** 模板列定义（stored snake_case）→ 建实体表用的 {@link GridColumnDef}（camelCase）。 */
export function templateColumnDefs(template: WorkbookTemplate): GridColumnDef[] {
  const storedDefs = template.sheets[0]?.columnDefs ?? template.columnDefs;
  return storedDefs.map(storedColumnToDTO);
}

/** 把模板包的全部数据表转为工作簿实例化输入。 */
export function templateSheetsForCreate(template: WorkbookTemplate): TemplateSheetForCreate[] {
  return template.sheets.map((sheet) => ({
    label: sheet.label,
    columns: sheet.columnDefs.map(storedColumnToDTO),
  }));
}

/**
 * 直连 `workbook_template` 表的模板 store（纯逻辑工厂；runes 镜像在 workbook-templates.svelte.ts）。
 * 读：`SELECT * FROM workbook_template ORDER BY sort_order`——隔离靠 db 边界，不带鉴权过滤。
 */
export function createWorkbookTemplatesStore(deps: WorkbookTemplatesDeps) {
  const state: WorkbookTemplatesState = {
    loading: false,
    error: null,
    templates: [],
  };

  function emit(): void {
    deps.onChange?.({ loading: state.loading, error: state.error, templates: state.templates });
  }

  async function load(): Promise<void> {
    state.loading = true;
    state.error = null;
    emit();
    try {
      const records = await deps
        .getConn()
        .query<Record<string, unknown>>("SELECT * FROM workbook_template ORDER BY sort_order");
      state.templates = records.map(recordToTemplate);
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  function byKey(key: string): WorkbookTemplate | undefined {
    return state.templates.find((tpl) => tpl.key === key);
  }

  return {
    get loading(): boolean { return state.loading; },
    get error(): string | null { return state.error; },
    get templates(): WorkbookTemplate[] { return state.templates; },
    load,
    byKey,
  };
}
