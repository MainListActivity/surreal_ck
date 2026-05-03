import { getLocalDb } from "../db/index";
import { ServiceError } from "./errors";
import type {
  GetTableSchemaRequest,
  GetTableSchemaResponse,
  GridColumnDef,
  TableSchemaField,
} from "../../shared/rpc.types";

const SAFE_TABLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENTITY_TABLE = /^ent_[a-z0-9_]+$/;

/**
 * 系统表字段标签映射。仅包含仪表盘 builder 实际会用到的可统计字段。
 * 系统字段(workspace/created_by/updated_at)保留但标注为系统列，UI 可隐藏。
 */
const SYSTEM_FIELD_LABELS: Record<string, Record<string, string>> = {
  workspace: {
    name: "名称",
    slug: "Slug",
    owner: "所有者",
    created_at: "创建时间",
    updated_at: "更新时间",
  },
  workbook: {
    workspace: "所属工作区",
    name: "名称",
    template_key: "模板",
    folder: "所在目录",
    created_at: "创建时间",
    updated_at: "更新时间",
  },
  sheet: {
    workbook: "所属工作簿",
    label: "名称",
    table_name: "表名",
    position: "排序",
    created_at: "创建时间",
    updated_at: "更新时间",
  },
  folder: {
    workspace: "所属工作区",
    name: "名称",
    parent: "父目录",
    position: "排序",
    created_at: "创建时间",
    updated_at: "更新时间",
  },
  app_user: {
    name: "用户名",
    display_name: "显示名",
    email: "邮箱",
    avatar: "头像",
    created_at: "创建时间",
    updated_at: "更新时间",
  },
};

const KNOWN_SYSTEM_TABLES = new Set(Object.keys(SYSTEM_FIELD_LABELS));

export async function getTableSchema(
  { table }: GetTableSchemaRequest,
): Promise<GetTableSchemaResponse> {
  const trimmed = table?.trim();
  if (!trimmed || !SAFE_TABLE.test(trimmed)) {
    throw new ServiceError("VALIDATION_ERROR", `非法的表名: ${table}`);
  }

  if (ENTITY_TABLE.test(trimmed)) {
    return { table: trimmed, origin: "entity", fields: await loadEntityFields(trimmed) };
  }

  if (KNOWN_SYSTEM_TABLES.has(trimmed)) {
    return { table: trimmed, origin: "system", fields: await loadSystemFields(trimmed) };
  }

  throw new ServiceError("NOT_FOUND", `未知的表: ${trimmed}`);
}

// ─── 业务表：从 sheet.column_defs 读 ────────────────────────────────────────

type StoredColumnDef = {
  key: string;
  label: string;
  field_type: string;
  required?: boolean;
  reference_table?: string;
};

type SheetColumnRow = {
  table_name: string;
  column_defs: StoredColumnDef[];
};

async function loadEntityFields(table: string): Promise<TableSchemaField[]> {
  const db = getLocalDb();
  const rows = await db.query<[SheetColumnRow[]]>(
    `SELECT table_name, column_defs FROM sheet WHERE table_name = $t LIMIT 1`,
    { t: table },
  );
  const sheet = rows[0]?.[0];
  if (!sheet) {
    throw new ServiceError("NOT_FOUND", `Sheet 未找到或无权访问: ${table}`);
  }
  const userFields: TableSchemaField[] = (sheet.column_defs ?? []).map((col) => ({
    key: col.key,
    label: col.label || col.key,
    fieldType: col.field_type,
    nullable: col.required === false,
    referenceTable: col.reference_table,
  }));
  // 业务表都有 workspace / created_by / created_at / updated_at 审计字段。
  return [
    ...userFields,
    { key: "id", label: "记录 ID", fieldType: "text", nullable: false },
    { key: "created_at", label: "创建时间", fieldType: "date", nullable: false },
    { key: "updated_at", label: "更新时间", fieldType: "date", nullable: false },
  ];
}

// ─── 系统表：从 INFO FOR TABLE 解析 DDL 字符串 ─────────────────────────────

type InfoForTableResult = {
  fields?: Record<string, string>;
};

async function loadSystemFields(table: string): Promise<TableSchemaField[]> {
  const db = getLocalDb();
  const result = await db.query<[InfoForTableResult]>(`INFO FOR TABLE ${table}`);
  const rawFields = result[0]?.fields ?? {};
  const labels = SYSTEM_FIELD_LABELS[table] ?? {};
  const fields: TableSchemaField[] = [];
  fields.push({ key: "id", label: "记录 ID", fieldType: "text", nullable: false });

  for (const [name, ddl] of Object.entries(rawFields)) {
    if (typeof ddl !== "string") continue;
    if (name.includes(".") || name.includes("[")) continue; // skip nested fields
    const parsed = parseSurrealType(ddl);
    fields.push({
      key: name,
      label: labels[name] ?? name,
      fieldType: parsed.fieldType,
      nullable: parsed.nullable,
      referenceTable: parsed.referenceTable,
    });
  }
  return fields;
}

type ParsedType = {
  fieldType: string;
  nullable: boolean;
  referenceTable?: string;
};

/**
 * 把 `DEFINE FIELD ... TYPE option<record<workspace>>` 这样的 DDL 串
 * 解析成 { fieldType, nullable, referenceTable }。
 */
function parseSurrealType(ddl: string): ParsedType {
  const match = ddl.match(/\bTYPE\s+([^\s][^;]*?)(?=\s+(?:VALUE|DEFAULT|ASSERT|PERMISSIONS|READONLY|REFERENCE|COMMENT)|\s*;|$)/i);
  const raw = match?.[1]?.trim() ?? "";
  return mapSurrealType(raw);
}

function mapSurrealType(raw: string): ParsedType {
  const optionMatch = raw.match(/^option<(.+)>$/i);
  if (optionMatch) {
    const inner = mapSurrealType(optionMatch[1].trim());
    return { ...inner, nullable: true };
  }

  const recordMatch = raw.match(/^record<(.+)>$/i);
  if (recordMatch) {
    return { fieldType: "reference", nullable: false, referenceTable: recordMatch[1].trim() };
  }

  const arrayMatch = raw.match(/^array<(.+?)(?:\s*,\s*\d+)?>$/i);
  if (arrayMatch) {
    return { fieldType: "json", nullable: false };
  }

  const lower = raw.toLowerCase();
  if (lower === "string") return { fieldType: "text", nullable: false };
  if (lower === "int" || lower === "float" || lower === "decimal" || lower === "number") {
    return { fieldType: "number", nullable: false };
  }
  if (lower === "bool") return { fieldType: "boolean", nullable: false };
  if (lower === "datetime") return { fieldType: "date", nullable: false };
  if (lower === "uuid") return { fieldType: "text", nullable: false };
  if (lower === "object") return { fieldType: "json", nullable: false };
  if (lower === "any") return { fieldType: "unknown", nullable: true };

  // set<...> / geometry / bytes / 其他
  if (lower.startsWith("set<")) return { fieldType: "json", nullable: false };
  if (lower.startsWith("geometry")) return { fieldType: "json", nullable: false };

  return { fieldType: "unknown", nullable: false };
}

// 暴露给测试 / dashboard-mastra 复用
export { parseSurrealType, mapSurrealType };
