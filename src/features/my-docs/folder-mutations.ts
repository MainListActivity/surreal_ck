import { RecordId, type Surreal } from 'surrealdb';

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
  workspaceId: string;
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

function toRecordId(value: string): RecordId {
  const [table, ...rest] = value.split(':');
  const id = rest.join(':');
  if (!table || !id) {
    throw new Error(`Invalid record id: ${value}`);
  }
  return new RecordId(table, id);
}

async function querySingleValue<T>(db: Surreal, sql: string, vars: Record<string, unknown>): Promise<T | null> {
  const [rows] = await db.query<[T[]]>(sql, vars);
  const first = rows?.[0];
  return first ?? null;
}

async function readParentId(db: Surreal, folderId: string): Promise<string | null> {
  const [rows] = await db.query<[string[]]>(
    `SELECT VALUE out FROM folder_parent WHERE in = $id LIMIT 1`,
    { id: folderId },
  );
  return rows?.[0] ? String(rows[0]) : null;
}

async function computeDepth(db: Surreal, folderId: string): Promise<number> {
  let currentId: string | null = folderId;
  let depth = 0;

  while (currentId && depth < 8) {
    currentId = await readParentId(db, currentId);
    if (currentId) {
      depth += 1;
    }
  }

  return depth;
}

async function wouldCreateCycle(db: Surreal, folderId: string, newParentId: string): Promise<boolean> {
  let currentId: string | null = newParentId;
  let hops = 0;

  while (currentId && hops < 8) {
    if (currentId === folderId) {
      return true;
    }
    currentId = await readParentId(db, currentId);
    hops += 1;
  }

  return false;
}

export async function createFolder(db: Surreal, options: CreateFolderOptions): Promise<FolderMutationResult> {
  try {
    const [createdRows] = await db.query<[Array<{ id: string }>]>(
      `
      INSERT INTO folder {
        workspace: $ws,
        name: $name
      }
      RETURN id
      `,
      { ws: toRecordId(options.workspaceId), name: options.name },
    );

    const folderId = String(createdRows?.[0]?.id ?? '');
    if (!folderId) {
      return { ok: false, error: '创建文件夹失败' };
    }

    if (options.parentFolderId) {
      await db.query(
        `RELATE $child->folder_parent->$parent CONTENT { position: $position }`,
        {
          child: toRecordId(folderId),
          parent: toRecordId(options.parentFolderId),
          position: options.position ?? 0,
        },
      );
    } else {
      await db.query(
        `RELATE $workspace->workspace_has_folder->$folder`,
        {
          workspace: toRecordId(options.workspaceId),
          folder: toRecordId(folderId),
        },
      );
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '创建文件夹失败' };
  }
}

export async function renameFolder(db: Surreal, options: RenameFolderOptions): Promise<FolderMutationResult> {
  try {
    await db.query(
      `UPDATE $folderId SET name = $name, updated_at = time::now()`,
      { folderId: options.folderId, name: options.name },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '重命名失败' };
  }
}

export async function deleteFolder(db: Surreal, options: DeleteFolderOptions): Promise<FolderMutationResult> {
  try {
    const childCount = Number(
      await querySingleValue<number>(db, `SELECT VALUE count() FROM folder_parent WHERE out = $id GROUP ALL`, { id: options.folderId }) ?? 0,
    );
    const workbookCount = Number(
      await querySingleValue<number>(db, `SELECT VALUE count() FROM folder_has_workbook WHERE in = $id GROUP ALL`, { id: options.folderId }) ?? 0,
    );

    if (childCount > 0 || workbookCount > 0) {
      return { ok: false, error: NON_EMPTY_FOLDER_ERROR };
    }

    await db.query(
      `
      DELETE folder_parent WHERE in = $id OR out = $id;
      DELETE workspace_has_folder WHERE out = $id;
      DELETE $id;
      `,
      { id: options.folderId },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '删除文件夹失败' };
  }
}

export async function moveFolder(db: Surreal, options: MoveFolderOptions): Promise<FolderMutationResult> {
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
        `
        BEGIN TRANSACTION;
        DELETE workspace_has_folder WHERE out = $folderId;
        DELETE folder_parent WHERE in = $folderId;
        RELATE $folderId->folder_parent->$parent CONTENT { position: $position };
        COMMIT;
        `,
        {
          folderId: toRecordId(options.folderId),
          parent: toRecordId(options.newParentId),
          position: options.position ?? 0,
        },
      );
      return { ok: true };
    }

    await db.query(
      `
      BEGIN TRANSACTION;
      DELETE folder_parent WHERE in = $folderId;
      DELETE workspace_has_folder WHERE out = $folderId;
      RELATE $workspaceId->workspace_has_folder->$folderId;
      COMMIT;
      `,
      {
        folderId: toRecordId(options.folderId),
        workspaceId: toRecordId(options.workspaceId),
      },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '移动文件夹失败' };
  }
}

export async function attachWorkbook(db: Surreal, options: AttachWorkbookOptions): Promise<FolderMutationResult> {
  try {
    await db.query(`DELETE folder_has_workbook WHERE out = $workbookId`, { workbookId: options.workbookId });
    await db.query(`RELATE $folderId->folder_has_workbook->$workbookId`, {
      folderId: toRecordId(options.folderId),
      workbookId: toRecordId(options.workbookId),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '归档工作簿失败' };
  }
}

export async function detachWorkbook(db: Surreal, options: DetachWorkbookOptions): Promise<FolderMutationResult> {
  try {
    await db.query(`DELETE folder_has_workbook WHERE out = $workbookId`, {
      workbookId: options.workbookId,
    });
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
