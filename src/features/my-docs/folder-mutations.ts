import type { DbAdapter } from '../../lib/surreal/db-adapter';

import { toRecordId } from '../../lib/surreal/record-id';

export type FolderMutationResult = { ok: true } | { ok: false; error: string };

interface CreateFolderOptions {
  name: string;
  workspaceId: string;
  parentFolderId?: string | null;
  position?: number;
}

interface RenameFolderOptions {
  folderId: string;
  name: string;
}

interface DeleteFolderOptions {
  folderId: string;
}

interface MoveFolderOptions {
  folderId: string;
  newParentId?: string | null;
  position?: number;
}

interface AttachWorkbookOptions {
  folderId: string;
  workbookId: string;
}

interface DetachWorkbookOptions {
  workbookId: string;
}

const NON_EMPTY_FOLDER_ERROR = '文件夹不为空，请先移除其中的内容';
const CYCLE_ERROR = '不能将文件夹移动到它自己的子文件夹中';
const DEPTH_ERROR = '文件夹最多支持 8 层';


async function readParentId(db: DbAdapter, folderId: string): Promise<string | null> {
  const [rows] = await db.query<[Array<{ parent: string | null }>]>(
    `SELECT VALUE parent FROM ONLY $id`,
    { id: toRecordId(folderId) },
  );
  const parent = rows?.[0]?.parent ?? null;
  return parent ? String(parent) : null;
}

async function computeDepth(db: DbAdapter, folderId: string): Promise<number> {
  let currentId: string | null = folderId;
  let depth = 0;

  while (currentId && depth < 8) {
    currentId = await readParentId(db, currentId);
    if (currentId) depth += 1;
  }

  return depth;
}

async function wouldCreateCycle(db: DbAdapter, folderId: string, newParentId: string): Promise<boolean> {
  let currentId: string | null = newParentId;
  let hops = 0;

  while (currentId && hops < 8) {
    if (currentId === folderId) return true;
    currentId = await readParentId(db, currentId);
    hops += 1;
  }

  return false;
}

export async function createFolder(db: DbAdapter, options: CreateFolderOptions): Promise<FolderMutationResult> {
  try {
    await db.query(
      `INSERT INTO folder {
        workspace: $ws,
        name:      $name,
        parent:    $parent,
        position:  $position
      }`,
      {
        ws:       toRecordId(options.workspaceId),
        name:     options.name,
        parent:   options.parentFolderId ? toRecordId(options.parentFolderId) : null,
        position: options.position ?? 0,
      },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '创建文件夹失败' };
  }
}

export async function renameFolder(db: DbAdapter, options: RenameFolderOptions): Promise<FolderMutationResult> {
  try {
    await db.query(
      `UPDATE $id SET name = $name, updated_at = time::now()`,
      { id: toRecordId(options.folderId), name: options.name },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '重命名失败' };
  }
}

export async function deleteFolder(db: DbAdapter, options: DeleteFolderOptions): Promise<FolderMutationResult> {
  try {
    const [[childCount], [workbookCount]] = await db.query<[[number], [number]]>(
      `SELECT VALUE count() FROM folder WHERE parent = $id GROUP ALL;
       SELECT VALUE count() FROM workbook WHERE folder = $id GROUP ALL`,
      { id: toRecordId(options.folderId) },
    );

    if ((childCount ?? 0) > 0 || (workbookCount ?? 0) > 0) {
      return { ok: false, error: NON_EMPTY_FOLDER_ERROR };
    }

    await db.query(`DELETE $id`, { id: toRecordId(options.folderId) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '删除文件夹失败' };
  }
}

export async function moveFolder(db: DbAdapter, options: MoveFolderOptions): Promise<FolderMutationResult> {
  try {
    if (options.newParentId) {
      if (await wouldCreateCycle(db, options.folderId, options.newParentId)) {
        return { ok: false, error: CYCLE_ERROR };
      }

      const newParentDepth = await computeDepth(db, options.newParentId);
      if (newParentDepth + 1 >= 8) {
        return { ok: false, error: DEPTH_ERROR };
      }

      await db.query(
        `UPDATE $id SET parent = $parent, position = $position, updated_at = time::now()`,
        {
          id:       toRecordId(options.folderId),
          parent:   toRecordId(options.newParentId),
          position: options.position ?? 0,
        },
      );
    } else {
      await db.query(
        `UPDATE $id SET parent = NONE, position = $position, updated_at = time::now()`,
        {
          id:       toRecordId(options.folderId),
          position: options.position ?? 0,
        },
      );
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '移动文件夹失败' };
  }
}

export async function attachWorkbook(db: DbAdapter, options: AttachWorkbookOptions): Promise<FolderMutationResult> {
  try {
    await db.query(
      `UPDATE $workbookId SET folder = $folderId, updated_at = time::now()`,
      {
        workbookId: toRecordId(options.workbookId),
        folderId:   toRecordId(options.folderId),
      },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '归档工作簿失败' };
  }
}

export async function detachWorkbook(db: DbAdapter, options: DetachWorkbookOptions): Promise<FolderMutationResult> {
  try {
    await db.query(
      `UPDATE $workbookId SET folder = NONE, updated_at = time::now()`,
      { workbookId: toRecordId(options.workbookId) },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '移出文件夹失败' };
  }
}

export {
  CYCLE_ERROR,
  DEPTH_ERROR,
  NON_EMPTY_FOLDER_ERROR,
};
