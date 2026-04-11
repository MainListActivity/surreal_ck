import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import type { Surreal } from 'surrealdb';

import { detachWorkbook } from './folder-mutations';
import type { FolderNode } from './use-doc-tree';
import { useDocTree } from './use-doc-tree';
import { useFolderContents } from './use-folder-contents';

interface WorkbookRow {
  id: string;
  name: string;
  updated_at?: string | null;
}

interface MenuState {
  type: 'folder' | 'workbook';
  id: string;
  x: number;
  y: number;
}

export interface FolderContentsPaneProps {
  db: Surreal;
  workspaceId: string;
  selectedFolderId: string | null;
  displayName?: string;
  onOpenWorkbook: (id: string) => void;
  onFolderSelect: (id: string | null) => void;
}

function findFolderPath(nodes: FolderNode[], targetId: string): FolderNode[] {
  for (const node of nodes) {
    if (node.id === targetId) {
      return [node];
    }
    const childPath = findFolderPath(node.children, targetId);
    if (childPath.length > 0) {
      return [node, ...childPath];
    }
  }
  return [];
}

function formatDate(value?: string | null): string {
  if (!value) return '刚刚更新';
  return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function FolderContentsPane({
  db,
  workspaceId,
  selectedFolderId,
  displayName = '我',
  onOpenWorkbook,
  onFolderSelect,
}: FolderContentsPaneProps) {
  const tree = useDocTree(db, workspaceId);
  const contents = useFolderContents(db, selectedFolderId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [alert, setAlert] = useState<string | null>(null);

  const breadcrumbs = selectedFolderId ? findFolderPath(tree.folders, selectedFolderId) : [];
  const selectedFolderName = breadcrumbs[breadcrumbs.length - 1]?.name ?? '我的文档';

  const rows = useMemo(() => {
    if (!selectedFolderId) {
      return {
        folders: tree.folders.map((folder) => ({ id: folder.id, name: folder.name })),
        workbooks: tree.unfiledWorkbooks,
      };
    }

    return {
      folders: contents.subfolders.map((folder) => ({ id: folder.id, name: folder.name })),
      workbooks: contents.workbooks,
    };
  }, [contents.subfolders, contents.workbooks, selectedFolderId, tree.folders, tree.unfiledWorkbooks]);

  const isLoading = selectedFolderId ? contents.isLoading : tree.isLoading;
  const error = selectedFolderId ? contents.error : tree.error;

  async function handleDetach(workbookId: string) {
    const result = await detachWorkbook(db, { workbookId });
    if (!result.ok) {
      setAlert(result.error);
      return;
    }

    setAlert(null);
    await tree.refetch();
    await contents.refetch();
  }

  return (
    <section className="tdocs-folder-pane" aria-label="我的文档内容">
      <header className="tdocs-folder-pane__header">
        <div>
          <p className="tdocs-folder-pane__label">My Cloud Doc</p>
          <div className="tdocs-folder-pane__breadcrumbs">
            <button type="button" onClick={() => onFolderSelect(null)}>我的文档</button>
            {breadcrumbs.map((folder, index) => (
              <button key={folder.id} type="button" onClick={() => onFolderSelect(index === breadcrumbs.length - 1 ? folder.id : folder.id)}>
                / {folder.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      {alert ? <p className="tdocs-folder-pane__alert" role="alert">{alert}</p> : null}
      {error ? <p className="tdocs-folder-pane__alert" role="alert">{error}</p> : null}
      {isLoading ? <div className="tdocs-folder-pane__state">正在加载文件夹内容…</div> : null}

      {!isLoading && !error ? (
        <div className="tdocs-table-wrap">
          <table className="tdocs-table">
            <thead>
              <tr>
                <th className="tdocs-table__name-col">名称</th>
                <th>所有者</th>
                <th className="tdocs-table__date-col">最近修改</th>
                <th>大小</th>
              </tr>
            </thead>
            <tbody>
              {rows.folders.map((folder) => (
                <tr key={folder.id} className="tdocs-table__row">
                  <td className="tdocs-table__name-cell">
                    <span className="tdocs-file-icon" aria-hidden="true">📁</span>
                    <button className="tdocs-table__name-btn" type="button" onDoubleClick={() => onFolderSelect(folder.id)}>
                      {folder.name}
                    </button>
                    <div className="tdocs-table__row-actions" style={{ opacity: 1 }}>
                      <button
                        className="tdocs-row-action"
                        type="button"
                        aria-label="更多操作"
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ type: 'folder', id: folder.id, x: rect.left, y: rect.bottom + 6 });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                  </td>
                  <td className="tdocs-table__meta">{displayName}</td>
                  <td className="tdocs-table__meta">{formatDate()}</td>
                  <td className="tdocs-table__meta">—</td>
                </tr>
              ))}

              {!selectedFolderId && rows.workbooks.length > 0 ? (
                <tr>
                  <td colSpan={4} className="tdocs-table__section">未分类 ({rows.workbooks.length})</td>
                </tr>
              ) : null}

              {rows.workbooks.map((workbook: WorkbookRow) => (
                <tr key={workbook.id} className="tdocs-table__row">
                  <td className="tdocs-table__name-cell">
                    <span className="tdocs-file-icon tdocs-file-icon--sheet" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <rect x="1" y="1" width="14" height="14" rx="2" fill="#1E6E3A" />
                        <path d="M4 5h8M4 8h8M4 11h5" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </span>
                    <button className="tdocs-table__name-btn" type="button" onClick={() => onOpenWorkbook(workbook.id)}>
                      {workbook.name}
                    </button>
                    <div className="tdocs-table__row-actions" style={{ opacity: 1 }}>
                      <button
                        className="tdocs-row-action"
                        type="button"
                        aria-label="更多操作"
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ type: 'workbook', id: workbook.id, x: rect.left, y: rect.bottom + 6 });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                  </td>
                  <td className="tdocs-table__meta">{displayName}</td>
                  <td className="tdocs-table__meta">{formatDate(workbook.updated_at)}</td>
                  <td className="tdocs-table__meta">—</td>
                </tr>
              ))}

              {rows.folders.length === 0 && rows.workbooks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="tdocs-table__empty">该文件夹为空</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {menu ? (
        <menu className="tdocs-context-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {menu.type === 'folder' ? (
            <button className="tdocs-context-menu__item" type="button" onClick={() => { onFolderSelect(menu.id); setMenu(null); }}>
              打开
            </button>
          ) : (
            <>
              <button className="tdocs-context-menu__item" type="button" onClick={() => { onOpenWorkbook(menu.id); setMenu(null); }}>
                打开
              </button>
              <button className="tdocs-context-menu__item" type="button" onClick={() => { void handleDetach(menu.id); setMenu(null); }}>
                移出文件夹
              </button>
            </>
          )}
        </menu>
      ) : null}
    </section>
  );
}
