export type SyncScopeKind = "remote" | "local" | "user-scoped";

export type SyncScopeEntry = {
  table: string;
  scope: SyncScopeKind;
  rowFilter?: (row: Record<string, unknown>) => boolean;
};

const appSettingFilter = (row: Record<string, unknown>) => row.sensitive !== true;

export const SYNC_SCOPE = [
  { table: "workspace", scope: "remote" },
  { table: "app_user", scope: "user-scoped" },
  { table: "has_workspace_member", scope: "remote" },
  { table: "pending_workspace_member", scope: "remote" },
  { table: "workbook", scope: "remote" },
  { table: "folder", scope: "remote" },
  { table: "sheet", scope: "remote" },
  { table: "edge_catalog", scope: "remote" },
  { table: "mutation", scope: "remote" },
  { table: "snapshot", scope: "remote" },
  { table: "presence", scope: "remote" },
  { table: "dashboard_page", scope: "remote" },
  { table: "dashboard_view", scope: "remote" },
  { table: "form_definition", scope: "remote" },
  { table: "intake_submission", scope: "remote" },
  { table: "workbook_file", scope: "remote" },
  { table: "research_session", scope: "remote" },
  { table: "resource_item", scope: "remote" },
  { table: "resource_embedding", scope: "remote" },
  { table: "client_error", scope: "remote" },
  { table: "app_setting", scope: "user-scoped", rowFilter: appSettingFilter },
] satisfies SyncScopeEntry[];

export const DYNAMIC_SYNC_PREFIXES = ["ent_", "rel_"] as const;

export const LOCAL_ONLY_TABLES = [
  "token_store",
  "app_meta",
  "mastra_memory_resource",
  "mastra_memory_thread",
  "mastra_memory_message",
  "mastra_workflow_run",
  "mastra_observability_span",
  "mastra_observability_event_raw",
  "dashboard_result_cache",
  "dashboard_run_log",
] as const;

export function getSyncScopeEntry(table: string): SyncScopeEntry | null {
  return SYNC_SCOPE.find((entry) => entry.table === table) ?? null;
}

export function isDynamicSyncTable(table: string): boolean {
  return DYNAMIC_SYNC_PREFIXES.some((prefix) => table.startsWith(prefix));
}

export function isInSyncScope(table: string): boolean {
  if (LOCAL_ONLY_TABLES.some((localOnly) => localOnly === table)) return false;
  return getSyncScopeEntry(table) !== null || isDynamicSyncTable(table);
}

export function shouldSyncRow(table: string, row: Record<string, unknown>): boolean {
  const entry = getSyncScopeEntry(table);
  if (!entry?.rowFilter) return isInSyncScope(table);
  return entry.rowFilter(row);
}
