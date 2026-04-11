import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Surreal } from 'surrealdb';

import { buildFolderTree, useDocTree } from './use-doc-tree';

function createMockDb(queryImpl?: ReturnType<typeof vi.fn>) {
  return {
    query: queryImpl ?? vi.fn(),
  } as unknown as Surreal;
}

describe('buildFolderTree', () => {
  it('drops nodes deeper than 8 levels', () => {
    const folders = Array.from({ length: 10 }, (_, index) => ({
      id: `folder:${index + 1}`,
      workspace: 'workspace:test',
      name: `Folder ${index + 1}`,
    }));
    const edges = Array.from({ length: 9 }, (_, index) => ({
      in: `folder:${index + 2}`,
      out: `folder:${index + 1}`,
      position: index,
    }));

    const tree = buildFolderTree(folders, edges);

    let cursor = tree[0];
    let count = 1;
    while (cursor.children[0]) {
      cursor = cursor.children[0];
      count += 1;
    }

    expect(count).toBe(8);
    expect(cursor.name).toBe('Folder 8');
  });

  it('attaches orphaned folders to root', () => {
    const tree = buildFolderTree(
      [
        { id: 'folder:1', workspace: 'workspace:test', name: 'Root' },
        { id: 'folder:2', workspace: 'workspace:test', name: 'Orphan' },
      ],
      [{ in: 'folder:2', out: 'folder:missing', position: 0 }],
    );

    expect(tree).toHaveLength(2);
    expect(tree.map((node) => node.name)).toEqual(['Root', 'Orphan']);
  });
});

describe('useDocTree', () => {
  it('loads folders and unfiled workbooks', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([
        [
          { id: 'folder:root-a', workspace: 'workspace:test', name: '案件台账' },
          { id: 'folder:root-b', workspace: 'workspace:test', name: '债权申报' },
          { id: 'folder:child', workspace: 'workspace:test', name: '子文件夹' },
        ],
        [{ id: 'workbook:1', name: '空白工作簿', updated_at: '2026-04-11T10:00:00Z' }],
      ] as any)
      .mockResolvedValueOnce([
        [{ in: 'folder:child', out: 'folder:root-a', position: 0 }],
      ] as any);

    const db = createMockDb(query);
    const { result } = renderHook(() => useDocTree(db, 'workspace:test'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.unfiledWorkbooks).toHaveLength(1);
    expect(result.current.folders).toHaveLength(2);
    expect(result.current.folders[0].children[0].name).toBe('子文件夹');
  });

  it('returns empty state for empty workspace', async () => {
    const query = vi.fn().mockResolvedValueOnce([[], []] as any);
    const db = createMockDb(query);

    const { result } = renderHook(() => useDocTree(db, 'workspace:test'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.folders).toEqual([]);
    expect(result.current.unfiledWorkbooks).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('surfaces db errors', async () => {
    const db = createMockDb(vi.fn().mockRejectedValue(new Error('boom')));

    const { result } = renderHook(() => useDocTree(db, 'workspace:test'));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.isLoading).toBe(false);
  });

  it('does not update state after unmount', async () => {
    let resolveQuery: ((value: unknown) => void) | undefined;
    const query = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const db = createMockDb(query);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { unmount } = renderHook(() => useDocTree(db, 'workspace:test'));
    unmount();
    resolveQuery?.([[], []] as any);

    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
