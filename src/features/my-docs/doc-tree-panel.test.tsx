import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Surreal } from 'surrealdb';

import { DocTreePanel } from './doc-tree-panel';

const mockUseDocTree = vi.fn();
const mockCreateFolder = vi.fn();
const mockRenameFolder = vi.fn();
const mockDeleteFolder = vi.fn();
const mockMoveFolder = vi.fn();

vi.mock('./use-doc-tree', () => ({
  useDocTree: (...args: unknown[]) => mockUseDocTree(...args),
}));

vi.mock('./folder-mutations', () => ({
  createFolder: (...args: unknown[]) => mockCreateFolder(...args),
  renameFolder: (...args: unknown[]) => mockRenameFolder(...args),
  deleteFolder: (...args: unknown[]) => mockDeleteFolder(...args),
  moveFolder: (...args: unknown[]) => mockMoveFolder(...args),
}));

const db = {} as Surreal;

function baseTree() {
  return {
    folders: [
      {
        id: 'folder:1',
        name: '案件台账',
        depth: 0,
        workbooks: [],
        children: [
          { id: 'folder:1-1', name: '子文件夹', depth: 1, workbooks: [], children: [] },
        ],
      },
      {
        id: 'folder:2',
        name: '债权申报',
        depth: 0,
        workbooks: [],
        children: [],
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DocTreePanel', () => {
  it('renders the folder tree', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);

    expect(screen.getByText('案件台账')).toBeInTheDocument();
    expect(screen.getByText('债权申报')).toBeInTheDocument();
  });

  it('toggles child visibility with the chevron', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '折叠文件夹' })[0]);
    expect(screen.queryByText('子文件夹')).not.toBeInTheDocument();
  });

  it('calls onSelectFolder when a folder is clicked', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    const onSelectFolder = vi.fn();
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={onSelectFolder} />);

    fireEvent.click(screen.getByText('债权申报'));
    expect(onSelectFolder).toHaveBeenCalledWith('folder:2');
  });

  it('renames a folder inline', async () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockRenameFolder.mockResolvedValue({ ok: true });
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    fireEvent.click(screen.getByText('重命名'));
    fireEvent.change(screen.getByLabelText('重命名文件夹'), { target: { value: '新的名称' } });
    fireEvent.keyDown(screen.getByLabelText('重命名文件夹'), { key: 'Enter' });

    await waitFor(() => {
      expect(mockRenameFolder).toHaveBeenCalledWith(db, { folderId: 'folder:1', name: '新的名称' });
    });
  });

  it('deletes an empty folder and refetches', async () => {
    const tree = baseTree();
    mockUseDocTree.mockReturnValue(tree);
    mockDeleteFolder.mockResolvedValue({ ok: true });
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId="folder:1" onSelectFolder={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => {
      expect(mockDeleteFolder).toHaveBeenCalledWith(db, { folderId: 'folder:1' });
      expect(tree.refetch).toHaveBeenCalled();
    });
  });

  it('shows mutation errors', async () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockDeleteFolder.mockResolvedValue({ ok: false, error: '文件夹不为空，请先移除其中的内容' });
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    fireEvent.click(screen.getByText('删除'));

    expect(await screen.findByRole('alert')).toHaveTextContent('文件夹不为空');
  });

  it('shows a loading state', () => {
    mockUseDocTree.mockReturnValue({ ...baseTree(), isLoading: true, folders: [] });
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);
    expect(screen.getByText('正在加载文件夹…')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    mockUseDocTree.mockReturnValue({ ...baseTree(), error: 'boom', folders: [] });
    render(<DocTreePanel db={db} workspaceId="workspace:test" selectedFolderId={null} onSelectFolder={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
