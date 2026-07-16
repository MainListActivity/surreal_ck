import { storedColumnToDTO, type StoredGridFieldDef } from "@surreal-ck/shared/field-schema";
import type {
  GridColumnDef,
  RecordIdString,
  WorkbookTemplate,
  WorkbookTemplateDefaultDashboard,
  WorkbookTemplateFieldDef,
  WorkbookTemplateQuickTask,
  WorkbookTemplateQuickTaskRisk,
  WorkbookTemplateSampleRecord,
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

  const sampleRecords = Array.isArray(rec.sample_records)
    ? (rec.sample_records as WorkbookTemplateSampleRecord[])
    : undefined;
  return {
    key: rec.key,
    label: rec.label,
    columnDefs: Array.isArray(rec.column_defs)
      ? (rec.column_defs as WorkbookTemplateFieldDef[])
      : [],
    ...(sampleRecords ? { sampleRecords } : {}),
  };
}

function recordToDefaultDashboard(value: unknown): WorkbookTemplateDefaultDashboard | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.title !== "string"
    || typeof rec.slug !== "string"
    || !Array.isArray(rec.widgets)
  ) return undefined;
  return {
    title: rec.title,
    slug: rec.slug,
    ...(typeof rec.description === "string" ? { description: rec.description } : {}),
    widgets: rec.widgets as WorkbookTemplateDefaultDashboard["widgets"],
  };
}

function recordToQuickTask(value: unknown): WorkbookTemplateQuickTask | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.key !== "string"
    || typeof rec.label !== "string"
    || typeof rec.task_text !== "string"
    || (rec.risk !== "query" && rec.risk !== "write" && rec.risk !== "ddl")
  ) return null;
  return {
    key: rec.key,
    label: rec.label,
    taskText: rec.task_text,
    sheetKeys: Array.isArray(rec.sheet_keys)
      ? rec.sheet_keys.filter((key): key is string => typeof key === "string")
      : [],
    risk: rec.risk as WorkbookTemplateQuickTaskRisk,
  };
}

function recordToRowAnalysis(value: unknown): WorkbookTemplate["rowAnalysis"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.background !== "string" || rec.background.trim() === "") return undefined;
  const fieldSemantics = Array.isArray(rec.field_semantics)
    ? rec.field_semantics.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const field = item as Record<string, unknown>;
        return typeof field.field_key === "string" && typeof field.meaning === "string"
          ? [{ fieldKey: field.field_key, meaning: field.meaning }]
          : [];
      })
    : [];
  const stringList = (input: unknown): string[] => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  return {
    background: rec.background,
    fieldSemantics,
    reviewPoints: stringList(rec.review_points),
    outputGuidance: stringList(rec.output_guidance),
  };
}

/** 把 `workbook_template` 记录裁成展示用 {@link WorkbookTemplate}（snake_case → camelCase）。 */
export function recordToTemplate(rec: Record<string, unknown>): WorkbookTemplate {
  const rawDefs = Array.isArray(rec.column_defs) ? (rec.column_defs as StoredGridFieldDef[]) : [];
  const sheets = Array.isArray(rec.sheet_defs)
    ? rec.sheet_defs.map(recordToTemplateSheet).filter((sheet): sheet is WorkbookTemplateSheet => sheet !== null)
    : [];
  const defaultDashboard = recordToDefaultDashboard(rec.default_dashboard);
  const quickTasks = Array.isArray(rec.quick_tasks)
    ? rec.quick_tasks.map(recordToQuickTask).filter((task): task is WorkbookTemplateQuickTask => task !== null)
    : [];
  const rowAnalysis = recordToRowAnalysis(rec.row_analysis);
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
    ...(defaultDashboard ? { defaultDashboard } : {}),
    ...(quickTasks.length > 0 ? { quickTasks } : {}),
    ...(rowAnalysis ? { rowAnalysis } : {}),
    builtin: rec.builtin === true,
    sortOrder: typeof rec.sort_order === "number" ? rec.sort_order : 0,
  };
}

/** 当前数据表可见的模板快捷任务。空配置返回 []，由抽屉保留通用入口。 */
export function quickTasksForSheet(
  template: WorkbookTemplate | undefined,
  templateSheetKey: string | null | undefined,
): WorkbookTemplateQuickTask[] {
  if (!template) return [];
  return (template.quickTasks ?? [])
    .filter((task) => task.sheetKeys.length === 0 || (
      templateSheetKey != null && task.sheetKeys.includes(templateSheetKey)
    ))
    .slice(0, 5);
}

type TemplateSheetInstance = {
  label: string;
  templateSheetKey?: string;
};

/**
 * 新实例直接读取稳定 key；迁移前实例按未改名标签回退，再按创建顺序恢复。
 * 顺序回退只服务旧数据，新实例不会依赖展示名称或数组位置。
 */
export function templateSheetKeyForInstance(
  template: WorkbookTemplate | undefined,
  currentSheet: TemplateSheetInstance | null | undefined,
  instanceSheets: readonly TemplateSheetInstance[],
): string | undefined {
  if (!template || !currentSheet) return undefined;
  if (currentSheet.templateSheetKey) return currentSheet.templateSheetKey;
  const byLabel = template.sheets.find((sheet) => sheet.label === currentSheet.label);
  if (byLabel) return byLabel.key;
  const index = instanceSheets.indexOf(currentSheet);
  return index >= 0 ? template.sheets[index]?.key : undefined;
}

/** 模板列定义（stored snake_case）→ 建实体表用的 {@link GridColumnDef}（camelCase）。 */
export function templateColumnDefs(template: WorkbookTemplate): GridColumnDef[] {
  const storedDefs = template.sheets[0]?.columnDefs ?? template.columnDefs;
  return storedDefs.map(storedColumnToDTO);
}

/** 把模板包的全部数据表转为工作簿实例化输入。 */
export function templateSheetsForCreate(template: WorkbookTemplate): TemplateSheetForCreate[] {
  return template.sheets.map((sheet) => ({
    key: sheet.key,
    label: sheet.label,
    columns: sheet.columnDefs.map((column) => ({
      ...storedColumnToDTO(column),
      referenceSheetKey: column.reference_sheet_key,
    })),
    ...(sheet.sampleRecords ? { sampleRecords: sheet.sampleRecords.map((sample) => ({
      key: sample.key,
      values: Object.fromEntries(Object.entries(sample.values).map(([field, value]) => {
        if (
          typeof value === "object"
          && value !== null
          && !Array.isArray(value)
          && typeof (value as Record<string, unknown>).sheet_key === "string"
          && typeof (value as Record<string, unknown>).record_key === "string"
        ) {
          return [field, {
            sheetKey: (value as Record<string, unknown>).sheet_key as string,
            recordKey: (value as Record<string, unknown>).record_key as string,
          }];
        }
        return [field, value];
      })),
    })) } : {}),
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
