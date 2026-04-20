import { useCallback, useEffect, useReducer } from 'react';
import type { DbAdapter } from '../../lib/surreal/db-adapter';

import { toRecordId } from '../../lib/surreal/record-id';
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
      return { subfolders: action.subfolders, workbooks: action.workbooks, isLoading: false, error: null };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    default:
      return state;
  }
}

async function loadFolderContents(
  db: DbAdapter,
  folderId: string,
): Promise<{ subfolders: FolderRow[]; workbooks: WorkbookRef[] }> {
  const [subfolderRows, workbookRows] = await db.query<[FolderRow[], WorkbookRef[]]>(
    `SELECT id, workspace, name, parent, position, created_at, updated_at
     FROM folder
     WHERE parent = $folderId
     ORDER BY position ASC;

     SELECT id, name, updated_at
     FROM workbook
     WHERE folder = $folderId
     ORDER BY updated_at DESC;`,
    { folderId: toRecordId(folderId) },
  );

  const subfolders = (subfolderRows ?? []).map((row) => ({
    ...row,
    id:        String(row.id),
    workspace: String(row.workspace),
    parent:    row.parent ? String(row.parent) : null,
    position:  typeof row.position === 'number' ? row.position : 0,
  }));

  const workbooks = (workbookRows ?? []).map((row) => ({
    ...row,
    id: String(row.id),
  }));

  return { subfolders, workbooks };
}

export interface UseFolderContentsResult extends State {
  refetch: () => Promise<void>;
}

export function useFolderContents(db: DbAdapter, folderId: string | null): UseFolderContentsResult {
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
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load folder contents.' });
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
      .then((result) => { if (!cancelled) dispatch({ type: 'load-ok', ...result }); })
      .catch((err) => {
        if (!cancelled) dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load folder contents.' });
      });
    return () => { cancelled = true; };
  }, [db, folderId]);

  return { ...state, refetch };
}
