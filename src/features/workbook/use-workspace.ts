import { useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';

const LAST_WORKSPACE_KEY = 'surreal_ck.last_workspace_id';

export interface WorkbookSummaryDb {
  id: string;
  name: string;
  template_key: string | null;
  created_at?: string | null;
  updated_at: string;
  workspace: string;
}

export interface WorkspaceDb {
  id: string;
  name: string;
  memberCount: number;
}

interface State {
  workspaces: WorkspaceDb[];
  workbooks: WorkbookSummaryDb[];
  activeWorkspaceId: string | null;
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; workspaces: WorkspaceDb[]; workbooks: WorkbookSummaryDb[]; activeWorkspaceId: string | null }
  | { type: 'load-err'; error: string }
  | { type: 'switch-workspace'; workspaceId: string }
  | { type: 'append-workbook'; workbook: WorkbookSummaryDb };

function pickActiveWorkspace(workspaces: WorkspaceDb[], preferred: string | null): string | null {
  if (!workspaces.length) return null;
  if (preferred && workspaces.some((ws) => ws.id === preferred)) return preferred;
  return workspaces[0].id;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return {
        workspaces: action.workspaces,
        workbooks: action.workbooks,
        activeWorkspaceId: action.activeWorkspaceId,
        isLoading: false,
        error: null,
      };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'switch-workspace': {
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, action.workspaceId);
      } catch {
        // ignore storage errors
      }
      return { ...state, activeWorkspaceId: action.workspaceId };
    }
    case 'append-workbook':
      return {
        ...state,
        workbooks: [action.workbook, ...state.workbooks.filter((wb) => wb.id !== action.workbook.id)],
      };
    default:
      return state;
  }
}

export interface UseWorkspaceResult extends State {
  /** 当前激活工作空间的完整对象，null 表示无工作空间 */
  activeWorkspace: WorkspaceDb | null;
  /** 当前工作空间下的 workbook 列表（已按工作空间过滤） */
  activeWorkbooks: WorkbookSummaryDb[];
  /** 切换当前工作空间，并持久化到 localStorage */
  switchWorkspace: (workspaceId: string) => void;
  /** 重新从数据库加载工作空间和工作簿 */
  reload: () => Promise<void>;
  /** 乐观插入新创建的 workbook，避免路由先跳转但列表尚未刷新 */
  appendWorkbook: (workbook: WorkbookSummaryDb) => void;
}

/**
 * 加载当前用户所有可见工作空间及其 workbook。
 * PERMISSIONS 在 SurrealDB 层控制可见性，前端不做额外权限过滤。
 * 通过 localStorage 记忆上次选择的工作空间。
 */
export function useWorkspace(db: Surreal): UseWorkspaceResult {
  const [state, dispatch] = useReducer(reducer, {
    workspaces: [],
    workbooks: [],
    activeWorkspaceId: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      dispatch({ type: 'load-start' });
      try {
        // 查询所有工作空间（PERMISSIONS 过滤，无需客户端添加 WHERE $auth）
        const results = await db.query<
          [Array<{ id: string; name: string; memberCount: number }>, WorkbookSummaryDb[]]
        >(
          `
          SELECT
            id,
            name,
            created_at AS created_at,
            count(->has_workspace_member) AS memberCount
          FROM workspace
          ORDER BY created_at ASC;

          SELECT
            id,
            name,
            template_key,
            updated_at,
            created_at,
            workspace
          FROM workbook
          ORDER BY updated_at DESC, created_at DESC;
          `,
        );

        if (cancelled) return;

        const workspaceRows = results[0];
        const workbookRows = results[1];

        const workspaces: WorkspaceDb[] = Array.isArray(workspaceRows)
          ? workspaceRows.map((ws) => ({
              id: String(ws.id),
              name: ws.name,
              memberCount: ws.memberCount ?? 0,
            }))
          : [];

        const workbooks: WorkbookSummaryDb[] = Array.isArray(workbookRows)
          ? workbookRows.map((wb) => ({ ...wb, id: String(wb.id), workspace: String(wb.workspace) }))
          : [];

        // 优先使用 localStorage 记忆的工作空间
        let preferred: string | null = null;
        try {
          preferred = localStorage.getItem(LAST_WORKSPACE_KEY);
        } catch {
          // ignore
        }

        const activeWorkspaceId = pickActiveWorkspace(workspaces, preferred);

        dispatch({ type: 'load-ok', workspaces, workbooks, activeWorkspaceId });
      } catch (err) {
        if (!cancelled) {
          dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load workspace.' });
        }
      }
    }

    void load();
    return () => { cancelled = true; };
  // db identity is stable (module-level singleton)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeWorkspace = state.workspaces.find((ws) => ws.id === state.activeWorkspaceId) ?? null;
  const activeWorkbooks = state.workbooks.filter((wb) => wb.workspace === state.activeWorkspaceId);

  function switchWorkspace(workspaceId: string) {
    dispatch({ type: 'switch-workspace', workspaceId });
  }

  async function reload() {
    dispatch({ type: 'load-start' });
    try {
      const results = await db.query<
        [Array<{ id: string; name: string; memberCount: number }>, WorkbookSummaryDb[]]
      >(
        `
        SELECT
          id,
          name,
          created_at AS created_at,
          count(->has_workspace_member) AS memberCount
        FROM workspace
        ORDER BY created_at ASC;

        SELECT
          id,
          name,
          template_key,
          updated_at,
          created_at,
          workspace
        FROM workbook
        ORDER BY updated_at DESC, created_at DESC;
        `,
      );

      const workspaceRows = results[0];
      const workbookRows = results[1];

      const workspaces: WorkspaceDb[] = Array.isArray(workspaceRows)
        ? workspaceRows.map((ws) => ({
            id: String(ws.id),
            name: ws.name,
            memberCount: ws.memberCount ?? 0,
          }))
        : [];

      const workbooks: WorkbookSummaryDb[] = Array.isArray(workbookRows)
        ? workbookRows.map((wb) => ({ ...wb, id: String(wb.id), workspace: String(wb.workspace) }))
        : [];

      const activeWorkspaceId = pickActiveWorkspace(workspaces, state.activeWorkspaceId);
      dispatch({ type: 'load-ok', workspaces, workbooks, activeWorkspaceId });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load workspace.' });
    }
  }

  function appendWorkbook(workbook: WorkbookSummaryDb) {
    dispatch({ type: 'append-workbook', workbook });
  }

  return { ...state, activeWorkspace, activeWorkbooks, switchWorkspace, reload, appendWorkbook };
}

export interface EntityRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Maps a template key + workspace key to the primary entity table name.
 */
export function templateToEntityTable(wsKey: string | null | undefined, templateKey: string | null | undefined): string | null {
  if (!wsKey || !templateKey) return null;
  const primaryEntity: Record<string, string> = {
    'legal-entity-tracker': 'company',
    'case-management': 'case',
  };
  const entity = primaryEntity[templateKey];
  if (!entity) return null;
  return `ent_${wsKey}_${entity}`;
}

export function formatUpdatedAt(isoString: string | undefined | null): string {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚更新';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}
