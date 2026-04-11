import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Surreal } from 'surrealdb';

import { useFolderContents } from './use-folder-contents';

function createMockDb(queryImpl?: ReturnType<typeof vi.fn>) {
  return {
    query: queryImpl ?? vi.fn(),
  } as unknown as Surreal;
}

describe('useFolderContents', () => {
  it('loads subfolders and workbooks', async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        { id: 'folder:child-a', workspace: 'workspace:test', name: 'A', parent: 'folder:root', position: 0 },
        { id: 'folder:child-b', workspace: 'workspace:test', name: 'B', parent: 'folder:root', position: 1 },
      ],
      [{ id: 'workbook:1', name: 'Workbook 1', updated_at: '2026-04-11T10:00:00Z' }],
    ] as any);
    const db = createMockDb(query);

    const { result } = renderHook(() => useFolderContents(db, 'folder:root'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.subfolders).toHaveLength(2);
    expect(result.current.workbooks).toHaveLength(1);
  });

  it('returns empty state for empty folder', async () => {
    const db = createMockDb(vi.fn().mockResolvedValueOnce([[], []] as any));

    const { result } = renderHook(() => useFolderContents(db, 'folder:root'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.subfolders).toEqual([]);
    expect(result.current.workbooks).toEqual([]);
  });

  it('stays dormant when folderId is null', async () => {
    const query = vi.fn();
    const db = createMockDb(query);

    const { result } = renderHook(() => useFolderContents(db, null));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.subfolders).toEqual([]);
    expect(result.current.workbooks).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('surfaces db errors', async () => {
    const db = createMockDb(vi.fn().mockRejectedValue(new Error('boom')));

    const { result } = renderHook(() => useFolderContents(db, 'folder:root'));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.isLoading).toBe(false);
  });
});
