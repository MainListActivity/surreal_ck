import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Surreal } from 'surrealdb';

import { FolderContentsPane } from './folder-contents-pane';

const mockUseDocTree = vi.fn();
const mockUseFolderContents = vi.fn();
const mockDetachWorkbook = vi.fn();

vi.mock('./use-doc-tree', () => ({
  useDocTree: (...args: unknown[]) => mockUseDocTree(...args),
}));

vi.mock('./use-folder-contents', () => ({
  useFolderContents: (...args: unknown[]) => mockUseFolderContents(...args),
}));

vi.mock('./folder-mutations', () => ({
  detachWorkbook: (...args: unknown[]) => mockDetachWorkbook(...args),
}));

const db = {} as Surreal;

function baseTree() {
  return {
    folders: [
      { id: 'folder:1', name: '案件台账', depth: 0, workbooks: [], children: [] },
    ],
    unfiledWorkbooks: [
      { id: 'workbook:1', name: '空白工作簿', updated_at: '2026-04-11T10:00:00Z' },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

function baseContents() {
  return {
    subfolders: [
      { id: 'folder:2', workspace: 'workspace:test', name: '子文件夹' },
    ],
    workbooks: [
      { id: 'workbook:2', name: '工作簿 2', updated_at: '2026-04-11T10:00:00Z' },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

describe('FolderContentsPane', () => {
  it('renders subfolders before workbooks', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue(baseContents());

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId="folder:1"
        onOpenWorkbook={vi.fn()}
        onFolderSelect={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons.some((button) => button.textContent === '子文件夹')).toBe(true);
    expect(buttons.some((button) => button.textContent === '工作簿 2')).toBe(true);
  });

  it('opens a workbook when the workbook row is clicked', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue(baseContents());
    const onOpenWorkbook = vi.fn();

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId="folder:1"
        onOpenWorkbook={onOpenWorkbook}
        onFolderSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('工作簿 2'));
    expect(onOpenWorkbook).toHaveBeenCalledWith('workbook:2');
  });

  it('navigates into a folder when folder row is double-clicked', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue(baseContents());
    const onFolderSelect = vi.fn();

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId="folder:1"
        onOpenWorkbook={vi.fn()}
        onFolderSelect={onFolderSelect}
      />,
    );

    fireEvent.doubleClick(screen.getByText('子文件夹'));
    expect(onFolderSelect).toHaveBeenCalledWith('folder:2');
  });

  it('shows the unfiled section at the root', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue(baseContents());

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId={null}
        onOpenWorkbook={vi.fn()}
        onFolderSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('未分类 (1)')).toBeInTheDocument();
  });

  it('shows the empty state for empty folders', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue({ ...baseContents(), subfolders: [], workbooks: [] });

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId="folder:1"
        onOpenWorkbook={vi.fn()}
        onFolderSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('该文件夹为空')).toBeInTheDocument();
  });

  it('shows loading and error states', () => {
    mockUseDocTree.mockReturnValue(baseTree());
    mockUseFolderContents.mockReturnValue({ ...baseContents(), isLoading: true, error: 'boom' });

    render(
      <FolderContentsPane
        db={db}
        workspaceId="workspace:test"
        selectedFolderId="folder:1"
        onOpenWorkbook={vi.fn()}
        onFolderSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('正在加载文件夹内容…')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
