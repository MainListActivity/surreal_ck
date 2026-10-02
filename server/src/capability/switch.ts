import { StringRecordId } from "surrealdb";

/**
 * LCA-14 返工：新内容 / AI 能力灰度开关的读端求值。
 *
 * 开关行在 _system.platform_capability_switch，record id 即能力键
 * （platform_capability_switch:content / :ai）。行不存在 = mode "on"
 * （未初始化的部署不改变既有行为）。求值结果只决定本次会话签发/新 run
 * 是否放行；已下发会话与既有用户成果不受影响（满足"回滚维持权限收紧
 * 和已有用户成果"）。
 */

export type CapabilitySwitchKey = "content" | "ai";
export type CapabilitySwitchMode = "on" | "cohort" | "off";

export type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

export type CapabilitySwitchRow = {
  mode: CapabilitySwitchMode;
  workspaces: string[];
  note: string;
  updated_by: string | null;
  updated_at: string | null;
};

export type CapabilitySwitchDecision =
  | { allowed: true; mode: "on" | "cohort" }
  | { allowed: false; mode: "cohort" | "off"; workspaces: string[] };

/**
 * 取查询结果末条语句的首行：单语句 SELECT 的结果是 [[row]]，
 * LET…RETURN 复合语句的结果是 […, row]（RETURN 值在最后）。
 */
function firstRow(value: unknown): Record<string, unknown> | null {
  const statement = Array.isArray(value) ? value.at(-1) : value;
  const row = Array.isArray(statement) ? statement[0] : statement;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

export function readSwitchRow(value: unknown): CapabilitySwitchRow | null {
  const row = firstRow(value);
  if (!row) return null;
  const mode = row.mode;
  if (mode !== "on" && mode !== "cohort" && mode !== "off") return null;
  return {
    mode,
    workspaces: Array.isArray(row.workspaces) ? row.workspaces.map(String) : [],
    note: typeof row.note === "string" ? row.note : "",
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

/**
 * 判定某 workspace（db 名）当前是否允许使用能力。
 * cohort 模式按 workspace slug 白名单比对（db_name → slug 在同一条查询内解析）。
 * 查询失败向上抛——调用方映射成各自入口的 503/不可用（fail closed：
 * 读不到开关时不放行新会话）。
 */
export async function evaluateCapabilitySwitch(
  system: Queryable,
  key: CapabilitySwitchKey,
  workspaceDb: string,
): Promise<CapabilitySwitchDecision> {
  const result = await system.query(
    `
    LET $sw = (SELECT mode, workspaces FROM ONLY $switch);
    LET $ws = (SELECT slug FROM ONLY workspace WHERE db_name = $db LIMIT 1);
    RETURN { mode: $sw.mode ?? "on", workspaces: $sw.workspaces ?? [], slug: $ws.slug ?? NONE };
    `,
    { switch: new StringRecordId(`platform_capability_switch:${key}`), db: workspaceDb },
  );
  const row = firstRow(result);
  const mode = row?.mode === "off" || row?.mode === "cohort" ? row.mode : "on";
  if (mode === "on") return { allowed: true, mode: "on" };
  const workspaces = Array.isArray(row?.workspaces) ? row.workspaces.map(String) : [];
  const slug = typeof row?.slug === "string" ? row.slug : null;
  if (mode === "cohort" && slug !== null && workspaces.includes(slug)) {
    return { allowed: true, mode: "cohort" };
  }
  return { allowed: false, mode, workspaces };
}
