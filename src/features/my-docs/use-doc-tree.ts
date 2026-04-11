import { useCallback, useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';

const MAX_FOLDER_DEPTH = 8;

export interface FolderRow {
  id: string;
  workspace: string;
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WorkbookRef {
  id: string;
  name: string;
  updated_at?: string | null;
}

interface FolderParentEdge {
  in: string;
  out: string;
  position?: number | null;
}

export interface FolderNode {
  id: string;
  name: string;
  depth: number;
  children: FolderNode[];
  workbooks: WorkbookRef[];
}

interface State {
  folders: FolderNode[];
  unfiledWorkbooks: WorkbookRef[];
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; folders: FolderNode[]; unfiledWorkbooks: WorkbookRef[] }
  | { type: 'load-err'; error: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return {
        folders: action.folders,
        unfiledWorkbooks: action.unfiledWorkbooks,
        isLoading: false,
        error: null,
      };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    default:
      return state;
  }
}

function normalizeFolderRow(row: FolderRow): FolderRow {
  return {
    ...row,
    id: String(row.id),
    workspace: String(row.workspace),
  };
}

function normalizeWorkbookRow(row: WorkbookRef): WorkbookRef {
  return {
    ...row,
    id: String(row.id),
  };
}

function normalizeEdgeRow(row: FolderParentEdge): FolderParentEdge {
  return {
    in: String(row.in),
    out: String(row.out),
    position: typeof row.position === 'number' ? row.position : 0,
  };
}

function buildFolderTree(folderRows: FolderRow[], edgeRows: FolderParentEdge[]): FolderNode[] {
  const byId = new Map(folderRows.map((folder) => [folder.id, folder]));
  const childrenByParent = new Map<string, Array<{ id: string; position: number }>>();
  const childToParent = new Map<string, string>();

  for (const edge of edgeRows) {
    if (!byId.has(edge.in) || !byId.has(edge.out) || edge.in === edge.out) {
      continue;
    }
    childToParent.set(edge.in, edge.out);
    const siblings = childrenByParent.get(edge.out) ?? [];
    siblings.push({ id: edge.in, position: edge.position ?? 0 });
    childrenByParent.set(edge.out, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  const rootIds = folderRows
    .filter((folder) => !childToParent.has(folder.id) || !byId.has(childToParent.get(folder.id)!))
    .map((folder) => folder.id)
    .sort((a, b) => a.localeCompare(b));

  const buildNode = (folderId: string, depth: number, seen: Set<string>): FolderNode | null => {
    if (depth >= MAX_FOLDER_DEPTH || seen.has(folderId)) {
      return null;
    }

    const row = byId.get(folderId);
    if (!row) return null;

    const nextSeen = new Set(seen);
    nextSeen.add(folderId);

    const children = (childrenByParent.get(folderId) ?? [])
      .map(({ id }) => buildNode(id, depth + 1, nextSeen))
      .filter((node): node is FolderNode => node !== null);

    return {
      id: row.id,
      name: row.name,
      depth,
      children,
      workbooks: [],
    };
  };

  return rootIds
    .map((id) => buildNode(id, 0, new Set()))
    .filter((node): node is FolderNode => node !== null);
}

async function loadDocTree(db: Surreal, workspaceId: string): Promise<{ folders: FolderNode[]; unfiledWorkbooks: WorkbookRef[] }> {
  const [folderRows, unfiledRows] = await db.query<[FolderRow[], WorkbookRef[]]>(
    `
    SELECT id, workspace, name, created_at, updated_at
    FROM folder
    WHERE workspace = $wsId
    ORDER BY created_at ASC;

    SELECT id, name, updated_at
    FROM workbook
    WHERE workspace = $wsId
      AND id NOT IN (
        SELECT VALUE out
        FROM folder_has_workbook
        WHERE in.workspace = $wsId
      )
    ORDER BY updated_at DESC;
    `,
    { wsId: workspaceId },
  );

  const normalizedFolders = (folderRows ?? []).map(normalizeFolderRow);
  const normalizedUnfiled = (unfiledRows ?? []).map(normalizeWorkbookRow);

  if (normalizedFolders.length === 0) {
    return { folders: [], unfiledWorkbooks: normalizedUnfiled };
  }

  const [parentRows] = await db.query<[FolderParentEdge[]]>(
    `
    SELECT in, out, position
    FROM folder_parent
    WHERE in.workspace = $wsId
    `,
    { wsId: workspaceId },
  );

  const folders = buildFolderTree(normalizedFolders, (parentRows ?? []).map(normalizeEdgeRow));
  return { folders, unfiledWorkbooks: normalizedUnfiled };
}

export interface UseDocTreeResult extends State {
  refetch: () => Promise<void>;
}

export function useDocTree(db: Surreal, workspaceId: string | null): UseDocTreeResult {
  const [state, dispatch] = useReducer(reducer, {
    folders: [],
    unfiledWorkbooks: [],
    isLoading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!workspaceId) {
      dispatch({ type: 'load-ok', folders: [], unfiledWorkbooks: [] });
      return;
    }

    dispatch({ type: 'load-start' });
    try {
      const result = await loadDocTree(db, workspaceId);
      dispatch({ type: 'load-ok', ...result });
    } catch (err) {
      dispatch({
        type: 'load-err',
        error: err instanceof Error ? err.message : 'Failed to load document tree.',
      });
    }
  }, [db, workspaceId]);

  useEffect(() => {
    let cancelled = false;

    if (!workspaceId) {
      dispatch({ type: 'load-ok', folders: [], unfiledWorkbooks: [] });
      return;
    }

    dispatch({ type: 'load-start' });
    void loadDocTree(db, workspaceId)
      .then((result) => {
        if (cancelled) return;
        dispatch({ type: 'load-ok', ...result });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: 'load-err',
          error: err instanceof Error ? err.message : 'Failed to load document tree.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [db, workspaceId]);

  return { ...state, refetch };
}

export { MAX_FOLDER_DEPTH, buildFolderTree };
