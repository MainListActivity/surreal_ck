import { describe, expect, it, vi } from 'vitest';
import type { Surreal } from 'surrealdb';

import {
  attachWorkbook,
  createFolder,
  CYCLE_ERROR,
  deleteFolder,
  DEPTH_ERROR,
  detachWorkbook,
  moveFolder,
  NON_EMPTY_FOLDER_ERROR,
  renameFolder,
} from './folder-mutations';

function createMockDb(queryImpl?: ReturnType<typeof vi.fn>) {
  return {
    query: queryImpl ?? vi.fn(),
  } as unknown as Surreal;
}

describe('folder mutations', () => {
  it('createFolder creates the folder then relates it', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ id: 'folder:new' }]] as any)
      .mockResolvedValueOnce([[]] as any);

    const result = await createFolder(createMockDb(query), {
      name: '新建文件夹',
      workspaceId: 'workspace:test',
      parentFolderId: 'folder:parent',
      position: 2,
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('createFolder returns an error when create fails', async () => {
    const result = await createFolder(createMockDb(vi.fn().mockRejectedValue(new Error('boom'))), {
      name: '新建文件夹',
      workspaceId: 'workspace:test',
    });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('renameFolder updates folder name', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);
    const result = await renameFolder(createMockDb(query), { folderId: 'folder:1', name: '新的名称' });
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deleteFolder blocks deletion when folder is not empty', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[1]] as any)
      .mockResolvedValueOnce([[0]] as any);

    const result = await deleteFolder(createMockDb(query), { folderId: 'folder:1' });

    expect(result).toEqual({ ok: false, error: NON_EMPTY_FOLDER_ERROR });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('deleteFolder deletes empty folder', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[0]] as any)
      .mockResolvedValueOnce([[0]] as any)
      .mockResolvedValueOnce([[]] as any);

    const result = await deleteFolder(createMockDb(query), { folderId: 'folder:1' });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('moveFolder blocks cycles before writing', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([['folder:parent']] as any)
      .mockResolvedValueOnce([['folder:target']] as any);

    const result = await moveFolder(createMockDb(query), {
      folderId: 'folder:target',
      workspaceId: 'workspace:test',
      newParentId: 'folder:child',
    });

    expect(result).toEqual({ ok: false, error: CYCLE_ERROR });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('moveFolder blocks depth > 8', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[null]] as any)
      .mockResolvedValueOnce([['folder:7']] as any)
      .mockResolvedValueOnce([['folder:6']] as any)
      .mockResolvedValueOnce([['folder:5']] as any)
      .mockResolvedValueOnce([['folder:4']] as any)
      .mockResolvedValueOnce([['folder:3']] as any)
      .mockResolvedValueOnce([['folder:2']] as any)
      .mockResolvedValueOnce([['folder:1']] as any)
      .mockResolvedValueOnce([['folder:0']] as any);

    const result = await moveFolder(createMockDb(query), {
      folderId: 'folder:target',
      workspaceId: 'workspace:test',
      newParentId: 'folder:8',
    });

    expect(result).toEqual({ ok: false, error: DEPTH_ERROR });
  });

  it('moveFolder sends one transaction query on success', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[null]] as any)
      .mockResolvedValueOnce([[null]] as any)
      .mockResolvedValueOnce([[]] as any);

    const result = await moveFolder(createMockDb(query), {
      folderId: 'folder:1',
      workspaceId: 'workspace:test',
      newParentId: 'folder:2',
      position: 3,
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('BEGIN TRANSACTION;'), expect.any(Object));
  });

  it('attachWorkbook detaches first then relates', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any);

    const result = await attachWorkbook(createMockDb(query), {
      folderId: 'folder:1',
      workbookId: 'workbook:1',
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('detachWorkbook deletes the membership edge', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);
    const result = await detachWorkbook(createMockDb(query), { workbookId: 'workbook:1' });
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
