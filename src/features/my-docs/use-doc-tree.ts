import { useCallback, useEffect, useReducer } from 'react';
import { StringRecordId, type Surreal } from 'surrealdb';

const MAX_FOLDER_DEPTH = 8;

export interface FolderRow {
  id: string;
  workspace: string;
  name: string;
  parent: string | null;
  position: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WorkbookRef {
  id: string;
  name: string;
  updated_at?: string | null;
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
    parent: row.parent ? String(row.parent) : null,
    position: typeof row.position === 'number' ? row.position : 0,
  };
}

function normalizeWorkbookRow(row: WorkbookRef): WorkbookRef {
  return { ...row, id: String(row.id) };
}

export function buildFolderTree(folderRows: FolderRow[]): FolderNode[] {
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  const childrenByParent = new Map<string, FolderRow[]>();

  for (const folder of folderRows) {
    if (folder.parent && byId.has(folder.parent)) {
      const siblings = childrenByParent.get(folder.parent) ?? [];
      siblings.push(folder);
      childrenByParent.set(folder.parent, siblings);
    }
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  const rootFolders = folderRows
    .filter((f) => !f.parent || !byId.has(f.parent))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const buildNode = (folder: FolderRow, depth: number, seen: Set<string>): FolderNode | null => {
    if (depth >= MAX_FOLDER_DEPTH || seen.has(folder.id)) return null;

    const nextSeen = new Set(seen);
    nextSeen.add(folder.id);

    const children = (childrenByParent.get(folder.id) ?? [])
      .map((child) => buildNode(child, depth + 1, nextSeen))
      .filter((node): node is FolderNode => node !== null);

    return { id: folder.id, name: folder.name, depth, children, workbooks: [] };
  };

  return rootFolders
    .map((f) => buildNode(f, 0, new Set()))
    .filter((node): node is FolderNode => node !== null);
}

async function loadDocTree(
  db: Surreal,
  workspaceId: string,
): Promise<{ folders: FolderNode[]; unfiledWorkbooks: WorkbookRef[] }> {
  const [folderRows, unfiledRows] = await db.query<[FolderRow[], WorkbookRef[]]>(
    `SELECT id, workspace, name, parent, position, created_at, updated_at
     FROM folder
     WHERE workspace = $wsId
     ORDER BY position ASC, created_at ASC;

     SELECT id, name, updated_at
     FROM workbook
     WHERE workspace = $wsId AND folder = NONE
     ORDER BY updated_at DESC;`,
    { wsId: new StringRecordId(workspaceId) },
  );

  const normalizedFolders = (folderRows ?? []).map(normalizeFolderRow);
  const normalizedUnfiled = (unfiledRows ?? []).map(normalizeWorkbookRow);

  return {
    folders: buildFolderTree(normalizedFolders),
    unfiledWorkbooks: normalizedUnfiled,
  };
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
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load document tree.' });
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
      .then((result) => { if (!cancelled) dispatch({ type: 'load-ok', ...result }); })
      .catch((err) => {
        if (!cancelled) dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load document tree.' });
      });
    return () => { cancelled = true; };
  }, [db, workspaceId]);

  return { ...state, refetch };
}

export { MAX_FOLDER_DEPTH };
