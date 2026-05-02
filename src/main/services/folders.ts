import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { mapNullToSurrealNone } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import type {
  FolderDTO,
  ListFoldersRequest,
  ListFoldersResponse,
  CreateFolderRequest,
  CreateFolderResponse,
  MoveFolderRequest,
  MoveFolderResponse,
} from "../../shared/rpc.types";

type FolderRow = {
  id: RecordId;
  workspace: RecordId;
  name: string;
  parent?: RecordId;
  position: number;
};

export async function listFolders({
  workspaceId,
}: ListFoldersRequest): Promise<ListFoldersResponse> {
  await assertCanReadWorkspace(workspaceId);

  const db = getLocalDb();
  const rows = await db.query<[FolderRow[]]>(
    `SELECT id, workspace, name, parent, position FROM folder WHERE workspace = $ws ORDER BY position`,
    { ws: new StringRecordId(workspaceId) }
  );

  const folders: FolderDTO[] = (rows[0] ?? []).map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace),
    name: row.name,
    parentId: row.parent ? String(row.parent) : undefined,
    position: row.position,
  }));

  return { folders };
}

export async function createFolder({
  workspaceId,
  name,
  parentId,
}: CreateFolderRequest): Promise<CreateFolderResponse> {
  await assertCanWriteWorkspace(workspaceId);

  if (!name || !name.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "文件夹名称不能为空");
  }

  const db = getLocalDb();
  const wsId = new StringRecordId(workspaceId);

  const parentRecordId = parentId ? new StringRecordId(parentId) : null;
  if (parentRecordId) {
    const parentRows = await db.query<[{ id: RecordId }[]]>(
      `SELECT id FROM folder WHERE id = $parentId AND workspace = $ws LIMIT 1`,
      { parentId: parentRecordId, ws: wsId }
    );
    if (!parentRows[0]?.[0]) {
      throw new ServiceError("NOT_FOUND", "父文件夹不存在或不属于当前工作区");
    }
  }

  // 计算下一个 position
  const posRows = await db.query<[{ max_pos?: number }[]]>(
    `SELECT math::max(position) AS max_pos FROM folder WHERE workspace = $ws`,
    { ws: wsId }
  );
  const nextPos = ((posRows[0]?.[0]?.max_pos) ?? -1) + 1;

  const fKey = Bun.hash.wyhash(`${workspaceId}:folder:${Date.now()}`).toString(16).padStart(16, "0");
  const fId = new RecordId("folder", fKey);

  const parentLine = parentRecordId ? "parent: $parent," : "";
  const newRows = await db.query<[FolderRow[]]>(
    `UPSERT $fId CONTENT {
      workspace: $ws,
      name: $name,
      ${parentLine}
      position: $pos
    }`,
    {
      fId,
      ws: wsId,
      name: name.trim(),
      parent: parentRecordId,
      pos: nextPos,
    }
  );

  const row = newRows[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "文件夹创建失败");

  return {
    folder: {
      id: String(row.id),
      workspaceId: String(row.workspace),
      name: row.name,
      parentId: row.parent ? String(row.parent) : undefined,
      position: row.position,
    },
  };
}

export async function moveFolder({
  folderId,
  parentId,
}: MoveFolderRequest): Promise<MoveFolderResponse> {
  const db = getLocalDb();
  const fId = new StringRecordId(folderId);

  const currentRows = await db.query<[FolderRow[]]>(
    `SELECT id, workspace, name, parent, position FROM folder WHERE id = $fId LIMIT 1`,
    { fId }
  );
  const current = currentRows[0]?.[0];
  if (!current) {
    throw new ServiceError("NOT_FOUND", "文件夹不存在");
  }

  const workspaceId = String(current.workspace);
  await assertCanWriteWorkspace(workspaceId);

  if (parentId && parentId === folderId) {
    throw new ServiceError("VALIDATION_ERROR", "不能将目录移动到自身下");
  }

  let parentRecordId: StringRecordId | null = null;
  if (parentId) {
    parentRecordId = new StringRecordId(parentId);
    const parentRows = await db.query<[FolderRow[]]>(
      `SELECT id, workspace, name, parent, position FROM folder WHERE id = $pId LIMIT 1`,
      { pId: parentRecordId }
    );
    const parent = parentRows[0]?.[0];
    if (!parent) {
      throw new ServiceError("NOT_FOUND", "目标父目录不存在");
    }
    if (String(parent.workspace) !== workspaceId) {
      throw new ServiceError("VALIDATION_ERROR", "不能跨工作区移动目录");
    }

    // 循环检测：从目标父目录沿 parent 链向上，遇到自身则非法
    let cursor: RecordId | undefined = parent.parent;
    const visited = new Set<string>([String(parent.id)]);
    while (cursor) {
      const cursorKey = String(cursor);
      if (cursorKey === folderId) {
        throw new ServiceError("VALIDATION_ERROR", "不能将目录移动到自己的子目录下");
      }
      if (visited.has(cursorKey)) break;
      visited.add(cursorKey);
      const upRows = await db.query<[FolderRow[]]>(
        `SELECT id, workspace, name, parent, position FROM folder WHERE id = $cur LIMIT 1`,
        { cur: cursor }
      );
      const up = upRows[0]?.[0];
      cursor = up?.parent;
    }
  }

  const updated = await db.query<[FolderRow[]]>(
    `UPDATE $fId SET parent = $parent`,
    { fId, parent: mapNullToSurrealNone(parentRecordId) }
  );
  const row = updated[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "目录移动失败");

  return {
    folder: {
      id: String(row.id),
      workspaceId: String(row.workspace),
      name: row.name,
      parentId: row.parent ? String(row.parent) : undefined,
      position: row.position,
    },
  };
}
