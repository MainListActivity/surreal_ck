import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanReadWorkspace, assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import type {
  FolderDTO,
  ListFoldersRequest,
  ListFoldersResponse,
  CreateFolderRequest,
  CreateFolderResponse,
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
  assertCanReadWorkspace(workspaceId);

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
  assertCanWriteWorkspace(workspaceId);

  if (!name || !name.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "文件夹名称不能为空");
  }

  const db = getLocalDb();
  const wsId = new StringRecordId(workspaceId);

  // 计算下一个 position
  const posRows = await db.query<[{ max_pos?: number }[]]>(
    `SELECT math::max(position) AS max_pos FROM folder WHERE workspace = $ws`,
    { ws: wsId }
  );
  const nextPos = ((posRows[0]?.[0]?.max_pos) ?? -1) + 1;

  const fKey = Bun.hash.wyhash(`${workspaceId}:folder:${Date.now()}`).toString(16).padStart(16, "0");
  const fId = new RecordId("folder", fKey);

  const newRows = await db.query<[FolderRow[]]>(
    `UPSERT $fId CONTENT {
      workspace: $ws,
      name: $name,
      parent: $parent,
      position: $pos
    }`,
    {
      fId,
      ws: wsId,
      name: name.trim(),
      parent: parentId ? new StringRecordId(parentId) : null,
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
