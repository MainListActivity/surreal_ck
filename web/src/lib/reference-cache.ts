import type { RecordIdString, ReferenceTargetOption, ReferenceTargetPreview } from "@surreal-ck/shared/rpc.types";
import { isLikelyRecordId, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";

export { isLikelyRecordId };

/**
 * 引用字段直连解析（替代 legacy 的后端 `appApi.resolveReferences`）。
 *
 * 浏览器直接按目标表分组跨表 SELECT：每张表一条
 * `SELECT id, <displayCols> FROM type::table($tb) WHERE id INSIDE $ids`（全参数化）。
 * 跨 workspace 隔离由 db 边界保证、行级权限由表 PERMISSIONS 兜底——查询不带鉴权过滤。
 *
 * 注意：直连模型拿不到 legacy 后端富化的 workspace/workbook/sheet 元数据，
 * 所以 {@link ReferenceTargetPreview} 的那些字段保持 undefined（组件已 `{#if}` 兜底）。
 */

/** displayKey 回退链：显式 displayKey（若有）→ name → display_name → email → id。 */
const DISPLAY_KEY_FALLBACK = ["name", "display_name", "email"] as const;

function tableOf(id: string): string {
  return id.slice(0, id.indexOf(":"));
}

/** 给一行的 values 提取出所有 reference 列对应的 RecordId 字符串，扁平化数组。 */
export function collectReferenceIdsFromValues(
  values: Record<string, unknown>,
  referenceKeys: string[],
): RecordIdString[] {
  const out: RecordIdString[] = [];
  for (const key of referenceKeys) {
    const v = values[key];
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") out.push(item as RecordIdString);
    } else if (typeof v === "string") {
      out.push(v as RecordIdString);
    }
  }
  return out;
}

/** 按 fallback 链挑第一个非空字段值作为 primaryLabel。 */
function pickPrimaryLabel(
  record: Record<string, unknown>,
  displayKey: string | undefined,
): string | null {
  const keys = displayKey ? [displayKey, ...DISPLAY_KEY_FALLBACK] : [...DISPLAY_KEY_FALLBACK];
  for (const key of keys) {
    const value = record[key];
    if (value != null && String(value) !== "") return String(value);
  }
  return null;
}

/** 把一条记录裁成展示用 preview 字段（剔系统字段、跳过空值）。 */
const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);
function previewFields(record: Record<string, unknown>): ReferenceTargetPreview["preview"] {
  const out: ReferenceTargetPreview["preview"] = [];
  for (const [key, value] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    if (value == null || value === "") continue;
    out.push({ key, label: key, value });
    if (out.length >= 6) break;
  }
  return out;
}

/** 投影列：显式 displayKey + 回退链去重。 */
function displayProjection(displayKey: string | undefined): string[] {
  const cols = displayKey ? [displayKey, ...DISPLAY_KEY_FALLBACK] : [...DISPLAY_KEY_FALLBACK];
  return Array.from(new Set(["id", ...cols]));
}

/**
 * 解析一批引用 id 为展示用 {@link ReferenceTargetPreview}。
 * 按目标表分组，每表一条参数化 SELECT；查不到的 id 标 `missing`。
 *
 * @param displayKeyByTable 可选：指定某表用哪个字段做 primaryLabel（来自列定义的 referenceDisplayKey）。
 */
export async function resolveReferences(
  conn: SurrealConn,
  ids: Array<RecordIdString | string>,
  displayKeyByTable: Record<string, string | undefined> = {},
): Promise<ReferenceTargetPreview[]> {
  const valid = ids.filter((id): id is string => typeof id === "string" && isLikelyRecordId(id));
  if (!valid.length) return [];

  const byTable = new Map<string, string[]>();
  for (const id of valid) {
    const tb = tableOf(id);
    const list = byTable.get(tb);
    if (list) list.push(id);
    else byTable.set(tb, [id]);
  }

  const out: ReferenceTargetPreview[] = [];
  for (const [tb, tbIds] of byTable) {
    const displayKey = displayKeyByTable[tb];
    const projection = displayProjection(displayKey).join(", ");
    // id 是 record 字段，与 string 数组比较永远不相等——逐项包成 RecordId 再绑定。
    const records = await conn.query<Record<string, unknown>>(
      `SELECT ${projection} FROM type::table($tb) WHERE id INSIDE $ids`,
      { tb, ids: tbIds.map(toRecordId) },
    );
    const found = new Map(records.map((r) => [String(r.id), r]));
    for (const id of tbIds) {
      const record = found.get(id);
      if (!record) {
        out.push({ id: id as RecordIdString, table: tb, primaryLabel: "已删除的记录", missing: true, preview: [] });
        continue;
      }
      out.push({
        id: id as RecordIdString,
        table: tb,
        primaryLabel: pickPrimaryLabel(record, displayKey) ?? id,
        preview: previewFields(record),
      });
    }
  }
  return out;
}

export type SearchCandidatesOptions = {
  query?: string;
  displayKey?: string;
  limit?: number;
};

/**
 * 候选搜索：`SELECT <displayCols> FROM type::table($tb) [WHERE <displayKey> CONTAINS $q] LIMIT N`。
 * 空 query 返回前 N 条；displayKey 缺省回退到 name。结果裁成 {@link ReferenceTargetPreview}。
 */
export async function searchReferenceCandidates(
  conn: SurrealConn,
  table: string,
  options: SearchCandidatesOptions = {},
): Promise<ReferenceTargetPreview[]> {
  const displayKey = options.displayKey;
  const limit = options.limit ?? 30;
  const query = options.query?.trim() ?? "";
  const projection = displayProjection(displayKey).join(", ");
  const searchCol = displayKey ?? DISPLAY_KEY_FALLBACK[0];

  let sql = `SELECT ${projection} FROM type::table($tb)`;
  const bindings: Record<string, unknown> = { tb: table };
  if (query) {
    sql += ` WHERE ${searchCol} CONTAINS $q`;
    bindings.q = query;
  }
  sql += ` LIMIT ${limit}`;

  const records = await conn.query<Record<string, unknown>>(sql, bindings);
  return records.map((record) => ({
    id: String(record.id) as RecordIdString,
    table,
    primaryLabel: pickPrimaryLabel(record, displayKey) ?? String(record.id),
    preview: previewFields(record),
  }));
}

/** sheet 记录上派生引用目标所需的字段；column_defs 是 storedDef（snake_case）。 */
type SheetTargetRow = {
  id: unknown;
  label?: unknown;
  table_name?: unknown;
  workbook?: unknown;
  workbook_name?: unknown;
  column_defs?: Array<{ key: string; label: string; field_type: string }>;
};

/** 系统对象目标：成员引用选 user 表；displayKeys 对齐 workspace 模板的 user schema。 */
const USER_TARGET: ReferenceTargetOption = {
  table: "user",
  label: "系统：用户",
  displayKeys: [
    { key: "display_name", label: "显示名", fieldType: "text" },
    { key: "email", label: "邮箱", fieldType: "text" },
  ],
};

/**
 * 枚举本 workspace 内可作为引用目标的表（替代 legacy 后端 `appApi.listReferenceTargets`）。
 *
 * 直连一条 `SELECT ... FROM sheet`（含 `workbook.name` record link 取工作簿名），每个
 * sheet 派生一个 ent_* 目标，displayKeys 取自 column_defs。系统对象 `user` 恒在首位。
 * 跨 workspace 隔离由 db 边界保证——这里天然只看得到当前 workspace 的 sheet。
 */
export async function listReferenceTargets(conn: SurrealConn): Promise<ReferenceTargetOption[]> {
  const rows = await conn.query<SheetTargetRow>(
    "SELECT id, label, table_name, column_defs, workbook, workbook.name AS workbook_name FROM sheet ORDER BY created_at ASC",
  );
  const targets: ReferenceTargetOption[] = [USER_TARGET];
  for (const row of rows) {
    if (typeof row.table_name !== "string" || !row.table_name) continue;
    targets.push({
      table: row.table_name,
      label: [row.workbook_name, row.label].filter(Boolean).join(" / "),
      workbookId: String(row.workbook) as RecordIdString,
      workbookName: typeof row.workbook_name === "string" ? row.workbook_name : undefined,
      sheetId: String(row.id) as RecordIdString,
      sheetName: typeof row.label === "string" ? row.label : undefined,
      displayKeys: (row.column_defs ?? []).map((c) => ({
        key: c.key,
        label: c.label,
        fieldType: c.field_type,
      })),
    });
  }
  return targets;
}
