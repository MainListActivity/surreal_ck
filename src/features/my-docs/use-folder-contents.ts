import { useCallback, useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';

import type { FolderRow, WorkbookRef } from './use-doc-tree';

interface State {
  subfolders: FolderRow[];
  workbooks: WorkbookRef[];
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; subfolders: FolderRow[]; workbooks: WorkbookRef[] }
  | { type: 'load-err'; error: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return {
        subfolders: action.subfolders,
        workbooks: action.workbooks,
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

async function loadFolderContents(db: Surreal, folderId: string): Promise<{ subfolders: FolderRow[]; workbooks: WorkbookRef[] }> {
  const [subfolderRows, workbookRows] = await db.query<[FolderRow[], WorkbookRef[]]>(
    `
    SELECT in.* AS folder
    FROM folder_parent
    WHERE out = $folderId
    ORDER BY position ASC;

    SELECT out.* AS workbook
    FROM folder_has_workbook
    WHERE in = $folderId
    ORDER BY out.updated_at DESC;
    `,
    { folderId },
  );

  const subfolders = (subfolderRows ?? [])
    .map((row) => ('folder' in row ? (row as { folder: FolderRow }).folder : row))
    .map(normalizeFolderRow);
  const workbooks = (workbookRows ?? [])
    .map((row) => ('workbook' in row ? (row as { workbook: WorkbookRef }).workbook : row))
    .map(normalizeWorkbookRow);

  return { subfolders, workbooks };
}

export interface UseFolderContentsResult extends State {
  refetch: () => Promise<void>;
}

export function useFolderContents(db: Surreal, folderId: string | null): UseFolderContentsResult {
  const [state, dispatch] = useReducer(reducer, {
    subfolders: [],
    workbooks: [],
    isLoading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!folderId) {
      dispatch({ type: 'load-ok', subfolders: [], workbooks: [] });
      return;
    }

    dispatch({ type: 'load-start' });
    try {
      const result = await loadFolderContents(db, folderId);
      dispatch({ type: 'load-ok', ...result });
    } catch (err) {
      dispatch({
        type: 'load-err',
        error: err instanceof Error ? err.message : 'Failed to load folder contents.',
      });
    }
  }, [db, folderId]);

  useEffect(() => {
    let cancelled = false;

    if (!folderId) {
      dispatch({ type: 'load-ok', subfolders: [], workbooks: [] });
      return;
    }

    dispatch({ type: 'load-start' });
    void loadFolderContents(db, folderId)
      .then((result) => {
        if (cancelled) return;
        dispatch({ type: 'load-ok', ...result });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: 'load-err',
          error: err instanceof Error ? err.message : 'Failed to load folder contents.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [db, folderId]);

  return { ...state, refetch };
}
