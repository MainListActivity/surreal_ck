import { describe, expect, it, vi } from 'vitest';
import type { DbAdapter } from '../../lib/surreal/db-adapter';

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
  } as unknown as DbAdapter;
}

describe('folder mutations', () => {
  it('createFolder inserts folder with parent field', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);

    const result = await createFolder(createMockDb(query), {
      name:           '新建文件夹',
      workspaceId:    'workspace:test',
      parentFolderId: 'folder:parent',
      position:       2,
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO folder'),
      expect.objectContaining({ name: '新建文件夹' }),
    );
  });

  it('createFolder creates root folder (no parent)', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);

    const result = await createFolder(createMockDb(query), {
      name:        '根文件夹',
      workspaceId: 'workspace:test',
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('createFolder returns an error when create fails', async () => {
    const result = await createFolder(
      createMockDb(vi.fn().mockRejectedValue(new Error('boom'))),
      { name: '新建文件夹', workspaceId: 'workspace:test' },
    );

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('renameFolder updates folder name', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);
    const result = await renameFolder(createMockDb(query), { folderId: 'folder:1', name: '新的名称' });
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deleteFolder blocks deletion when folder has children', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[1], [0]] as any);

    const result = await deleteFolder(createMockDb(query), { folderId: 'folder:1' });

    expect(result).toEqual({ ok: false, error: NON_EMPTY_FOLDER_ERROR });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deleteFolder blocks deletion when folder has workbooks', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[0], [1]] as any);

    const result = await deleteFolder(createMockDb(query), { folderId: 'folder:1' });

    expect(result).toEqual({ ok: false, error: NON_EMPTY_FOLDER_ERROR });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deleteFolder deletes empty folder', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[0], [0]] as any)
      .mockResolvedValueOnce([[]] as any);

    const result = await deleteFolder(createMockDb(query), { folderId: 'folder:1' });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('moveFolder blocks cycles before writing', async () => {
    // wouldCreateCycle: readParentId('folder:child') = 'folder:target'
    const query = vi.fn()
      .mockResolvedValueOnce([[{ parent: 'folder:target' }]] as any);

    const result = await moveFolder(createMockDb(query), {
      folderId:    'folder:target',
      newParentId: 'folder:child',
    });

    expect(result).toEqual({ ok: false, error: CYCLE_ERROR });
  });

  it('moveFolder blocks depth >= 8', async () => {
    // computeDepth for newParentId: chain of 8 parents
    const parentChain = [
      [[{ parent: 'folder:7' }]],
      [[{ parent: 'folder:6' }]],
      [[{ parent: 'folder:5' }]],
      [[{ parent: 'folder:4' }]],
      [[{ parent: 'folder:3' }]],
      [[{ parent: 'folder:2' }]],
      [[{ parent: 'folder:1' }]],
      [[{ parent: null }]],
    ];
    const query = vi.fn();
    // wouldCreateCycle: first readParentId returns null (no cycle)
    query.mockResolvedValueOnce([[{ parent: null }]] as any);
    // computeDepth: 8 hops
    for (const resp of parentChain) {
      query.mockResolvedValueOnce(resp as any);
    }

    const result = await moveFolder(createMockDb(query), {
      folderId:    'folder:target',
      newParentId: 'folder:8',
    });

    expect(result).toEqual({ ok: false, error: DEPTH_ERROR });
  });

  it('moveFolder updates parent field on success', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ parent: null }]] as any) // wouldCreateCycle
      .mockResolvedValueOnce([[{ parent: null }]] as any) // computeDepth
      .mockResolvedValueOnce([[]] as any);                // UPDATE

    const result = await moveFolder(createMockDb(query), {
      folderId:    'folder:1',
      newParentId: 'folder:2',
      position:    3,
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE'),
      expect.objectContaining({ parent: expect.anything() }),
    );
  });

  it('moveFolder to root clears parent field', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);

    const result = await moveFolder(createMockDb(query), {
      folderId: 'folder:1',
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('parent = NONE'),
      expect.any(Object),
    );
  });

  it('attachWorkbook sets folder field on workbook', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);

    const result = await attachWorkbook(createMockDb(query), {
      folderId:   'folder:1',
      workbookId: 'workbook:1',
    });

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('folder = $folderId'),
      expect.any(Object),
    );
  });

  it('detachWorkbook clears folder field on workbook', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]] as any);
    const result = await detachWorkbook(createMockDb(query), { workbookId: 'workbook:1' });
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('folder = NONE'),
      expect.any(Object),
    );
  });
});
