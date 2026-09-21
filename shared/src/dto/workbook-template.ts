import type { StoredGridFieldDef } from "../field-schema";
import type { DashboardBuilderSpec, DashboardViewType } from "./dashboard";
import type { RecordIdString } from "./transport";

// ─── Workbook template（直连模型）─────────────────────────────────────────────
// 工作簿「类型」= 业务模板的产物。底层不枚举行业类型，模板是 workspace 内
// `workbook_template` 表的数据行；前端直连读这张表拿到展示元数据（icon/accent/label），
// 不再用字符串硬猜。`column_defs` 与 sheet 同口径（StoredGridFieldDef[]），从模板
// 建工作簿时据此建实体表。下面这些 *DTO 是 pre-pivot 的后端 RPC 残留，已无人引用。

export type WorkbookTemplateFieldDef = StoredGridFieldDef & {
  /** 导入历史 Excel / CSV 时可与该字段匹配的列名。 */
  aliases?: string[];
  /** 模板包内目标数据表的稳定 key；实例化后不会写入数据表运行时元数据。 */
  reference_sheet_key?: string;
};

export type WorkbookTemplateSampleRecord = {
  /** 数据表内稳定 key；仅用于本次实例化时解析引用。 */
  key: string;
  /** 字段标识 → 模板值；引用字段可使用 WorkbookTemplateSampleReference。 */
  values: Record<string, unknown>;
};

/**
 * 模板默认仪表盘中的 widget。结构与 dashboard_page.widgets[] 的 DashboardWidget
 * 完全一致；实例化前 spec 中的表名位置使用模板数据表稳定 key。
 */
export type WorkbookTemplateDashboardWidget = {
  id: string;
  title: string;
  viewType: DashboardViewType;
  spec: DashboardBuilderSpec;
  grid: { x: number; y: number; w: number; h: number };
  display?: Record<string, unknown>;
};

export type WorkbookTemplateDefaultDashboard = {
  title: string;
  slug: string;
  description?: string;
  widgets: WorkbookTemplateDashboardWidget[];
};

export type WorkbookTemplateQuickTaskRisk = "query" | "write" | "ddl";

export type WorkbookTemplateQuickTask = {
  /** 模板包内稳定标识，仅用于 UI key，不进入 prompt。 */
  key: string;
  /** AI 抽屉显示文案。 */
  label: string;
  /** 点击后原样提交给 Router workflow 的任务文本。 */
  taskText: string;
  /** 空数组表示适用于该模板的全部数据表。 */
  sheetKeys: string[];
  risk: WorkbookTemplateQuickTaskRisk;
};

export type WorkbookTemplateRowAnalysis = {
  background: string;
  fieldSemantics: Array<{ fieldKey: string; meaning: string }>;
  reviewPoints: string[];
  outputGuidance: string[];
};

export type WorkbookTemplateSheet = {
  /** 模板包内稳定的数据表标识；实例化后不作为真实表名。 */
  key: string;
  /** 数据表展示名。 */
  label: string;
  columnDefs: WorkbookTemplateFieldDef[];
  /** 可选样例记录；用户选择空台账时不会实例化。 */
  sampleRecords?: WorkbookTemplateSampleRecord[];
};

export type WorkbookTemplate = {
  id: RecordIdString;
  key: string;
  label: string;
  description?: string;
  /** lucide 图标名；卡片直接据此渲染——视觉也由业务数据定义。 */
  icon?: string;
  /** 卡片强调色（hex）。 */
  accent?: string;
  /** 从模板新建时的默认工作簿名。 */
  defaultName?: string;
  /** 建实体表的列定义，与 sheet.column_defs 同口径。 */
  columnDefs: StoredGridFieldDef[];
  /** 通用模板包中的数据表定义。OIP-01 只实例化第一项。 */
  sheets: WorkbookTemplateSheet[];
  /** 可选默认仪表盘；widget spec 中的数据表名暂为模板数据表稳定 key。 */
  defaultDashboard?: WorkbookTemplateDefaultDashboard;
  /** 数据驱动的 AI 快捷任务；缺省时 AI 抽屉使用通用入口。 */
  quickTasks?: WorkbookTemplateQuickTask[];
  /** 通用行分析 agent 在当前工作簿内使用的模板领域说明。 */
  rowAnalysis?: WorkbookTemplateRowAnalysis;
  builtin: boolean;
  sortOrder: number;
};
