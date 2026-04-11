import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { Surreal } from 'surrealdb';

import { createFolder, deleteFolder, moveFolder, renameFolder } from './folder-mutations';
import type { FolderNode } from './use-doc-tree';
import { useDocTree } from './use-doc-tree';

interface MenuState {
  folderId: string;
  x: number;
  y: number;
}

export interface DocTreePanelProps {
  db: Surreal;
  workspaceId: string;
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
}

function flattenFolders(nodes: FolderNode[]): Array<{ id: string; name: string }> {
  const flat: Array<{ id: string; name: string }> = [];

  const visit = (node: FolderNode) => {
    flat.push({ id: node.id, name: node.name });
    node.children.forEach(visit);
  };

  nodes.forEach(visit);
  return flat;
}

export function DocTreePanel({
  db,
  workspaceId,
  selectedFolderId,
  onSelectFolder,
}: DocTreePanelProps) {
  const { folders, isLoading, error, refetch } = useDocTree(db, workspaceId);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);

  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);

  useEffect(() => {
    if (folders.length === 0) return;

    const nextExpanded = new Set<string>();
    const visit = (node: FolderNode) => {
      if (node.children.length > 0) {
        nextExpanded.add(node.id);
      }
      node.children.forEach(visit);
    };
    folders.forEach(visit);
    setExpandedIds((current) => new Set([...nextExpanded, ...current]));
  }, [folders]);

  useEffect(() => {
    if (!menu) return;

    const handleClick = () => setMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menu]);

  async function handleCreate(parentFolderId?: string | null) {
    const name = window.prompt(parentFolderId ? '输入子文件夹名称' : '输入文件夹名称', '新建文件夹');
    if (!name?.trim()) return;

    const result = await createFolder(db, {
      name: name.trim(),
      workspaceId,
      parentFolderId,
    });
    if (!result.ok) {
      setAlert(result.error);
      return;
    }

    setAlert(null);
    await refetch();
    if (parentFolderId) {
      setExpandedIds((current) => new Set(current).add(parentFolderId));
    }
  }

  async function commitRename(folderId: string) {
    if (!draftName.trim()) {
      setEditingId(null);
      setDraftName('');
      return;
    }

    const result = await renameFolder(db, { folderId, name: draftName.trim() });
    if (!result.ok) {
      setAlert(result.error);
      return;
    }

    setEditingId(null);
    setDraftName('');
    setAlert(null);
    await refetch();
  }

  async function handleDelete(folderId: string) {
    const result = await deleteFolder(db, { folderId });
    if (!result.ok) {
      setAlert(result.error);
      return;
    }

    if (selectedFolderId === folderId) {
      onSelectFolder(null);
    }
    setAlert(null);
    await refetch();
  }

  async function handleMove(folderId: string, newParentId: string | null) {
    const result = await moveFolder(db, {
      folderId,
      workspaceId,
      newParentId,
    });
    if (!result.ok) {
      setAlert(result.error);
      return;
    }

    setMoveTargetId(null);
    setAlert(null);
    await refetch();
  }

  function toggleExpanded(folderId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function startRename(folder: { id: string; name: string }) {
    setEditingId(folder.id);
    setDraftName(folder.name);
    setMenu(null);
  }

  function renderNode(node: FolderNode) {
    const isExpanded = expandedIds.has(node.id);
    const isEditing = editingId === node.id;
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.id}>
        <div
          className={`tdocs-tree-item ${selectedFolderId === node.id ? 'tdocs-tree-item--selected' : ''}`}
          style={{ paddingLeft: `${12 + node.depth * 16}px` }}
        >
          <button
            className="tdocs-tree-item__chevron"
            type="button"
            aria-label={isExpanded ? '折叠文件夹' : '展开文件夹'}
            onClick={() => toggleExpanded(node.id)}
          >
            {hasChildren ? (isExpanded ? '▼' : '▶') : '·'}
          </button>
          <button
            className="tdocs-tree-item__label"
            type="button"
            onClick={() => onSelectFolder(node.id)}
            onDoubleClick={() => toggleExpanded(node.id)}
          >
            <span className="tdocs-tree-item__icon" aria-hidden="true">📁</span>
            {isEditing ? (
              <input
                aria-label="重命名文件夹"
                autoFocus
                className="tdocs-tree-item__input"
                value={draftName}
                onBlur={() => { void commitRename(node.id); }}
                onChange={(event) => setDraftName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Enter') {
                    void commitRename(node.id);
                  }
                  if (event.key === 'Escape') {
                    setEditingId(null);
                    setDraftName('');
                  }
                }}
              />
            ) : (
              <span>{node.name}</span>
            )}
          </button>
          <button
            className="tdocs-tree-item__actions"
            type="button"
            aria-label="更多操作"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                folderId: node.id,
                x: rect.left,
                y: rect.bottom + 6,
              });
            }}
          >
            ⋯
          </button>
        </div>
        {hasChildren && isExpanded ? node.children.map(renderNode) : null}
      </div>
    );
  }

  const activeFolder = menu
    ? folderOptions.find((folder) => folder.id === menu.folderId) ?? null
    : null;

  return (
    <section className="tdocs-tree-panel" aria-label="我的文档树">
      <div className="tdocs-tree-panel__header">
        <button className="tdocs-tree-root" type="button" onClick={() => onSelectFolder(null)}>
          我的文档
        </button>
        <button className="tdocs-tree-panel__new" type="button" onClick={() => { void handleCreate(null); }}>
          新建文件夹
        </button>
      </div>

      {alert ? <p className="tdocs-tree-panel__alert" role="alert">{alert}</p> : null}
      {error ? <p className="tdocs-tree-panel__alert" role="alert">{error}</p> : null}
      {isLoading ? <div className="tdocs-tree-panel__state">正在加载文件夹…</div> : null}
      {!isLoading && !error && folders.length === 0 ? <div className="tdocs-tree-panel__state">还没有文件夹</div> : null}
      {!isLoading && !error ? <div className="tdocs-tree-list">{folders.map(renderNode)}</div> : null}

      {menu && activeFolder ? (
        <menu
          className="tdocs-context-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        >
          <button className="tdocs-context-menu__item" type="button" onClick={() => { onSelectFolder(activeFolder.id); setMenu(null); }}>
            打开
          </button>
          <button className="tdocs-context-menu__item" type="button" onClick={() => { void handleCreate(activeFolder.id); setMenu(null); }}>
            新建子文件夹
          </button>
          <button className="tdocs-context-menu__item" type="button" onClick={() => startRename(activeFolder)}>
            重命名
          </button>
          <button className="tdocs-context-menu__item" type="button" onClick={() => { setMoveTargetId(activeFolder.id); setMenu(null); }}>
            移动到…
          </button>
          <button className="tdocs-context-menu__item tdocs-context-menu__item--danger" type="button" onClick={() => { void handleDelete(activeFolder.id); setMenu(null); }}>
            删除
          </button>
        </menu>
      ) : null}

      {moveTargetId ? (
        <div className="tdocs-move-sheet" role="dialog" aria-modal="false" aria-label="移动文件夹">
          <div className="tdocs-move-sheet__card">
            <p className="tdocs-move-sheet__title">移动到</p>
            <button className="tdocs-move-sheet__option" type="button" onClick={() => { void handleMove(moveTargetId, null); }}>
              根目录
            </button>
            {folderOptions
              .filter((folder) => folder.id !== moveTargetId)
              .map((folder) => (
                <button
                  key={folder.id}
                  className="tdocs-move-sheet__option"
                  type="button"
                  onClick={() => { void handleMove(moveTargetId, folder.id); }}
                >
                  {folder.name}
                </button>
              ))}
            <button className="tdocs-move-sheet__cancel" type="button" onClick={() => setMoveTargetId(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
