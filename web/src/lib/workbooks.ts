import type { RecordIdString } from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import { describeWriteError } from "./workbook-data";

/**
 * workbook 列表项——直连读 `workbook` 表的裁剪形态。
 *
 * 新模型下 workbook 表不带 workspace 字段（跨 workspace 隔离靠 db 边界），也没有
 * folder 表，所以这里**不**带 workspaceId / folderId。「最近打开」等 scope 信息属于
 * 后端 Workspace Scope Module，不塞进 workbook 表。
 */
export type WorkbookRow = {
  id: RecordIdString;
  name: string;
  templateKey?: string;
  updatedAt?: string;
};

export type WorkbooksState = {
  loading: boolean;
  error: string | null;
  workbooks: WorkbookRow[];
};

export type WorkbooksSnapshot = WorkbooksState;

export type WorkbooksDeps = {
  getConn: () => SurrealConn;
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: WorkbooksSnapshot) => void;
};

export type WorkbooksStore = ReturnType<typeof createWorkbooksStore>;

/** 把 `workbook` 记录裁成展示用 {@link WorkbookRow}（剔系统字段，规范化 key）。 */
function recordToWorkbook(rec: Record<string, unknown>): WorkbookRow {
  return {
    id: String(rec.id) as RecordIdString,
    name: typeof rec.name === "string" ? rec.name : "",
    templateKey: typeof rec.template_key === "string" ? rec.template_key : undefined,
    updatedAt: typeof rec.updated_at === "string" ? rec.updated_at : undefined,
  };
}

/** 纯过滤：按 name / templateKey 大小写不敏感匹配；空 query 返回全部。 */
export function filterWorkbooksByQuery(workbooks: WorkbookRow[], query: string): WorkbookRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return workbooks;
  return workbooks.filter(
    (wb) => wb.name.toLowerCase().includes(q) || (wb.templateKey ?? "").toLowerCase().includes(q),
  );
}

/**
 * 直连 `workbook` 表的工作簿导航 store（纯逻辑工厂；runes 镜像在 workbooks.svelte.ts）。
 *
 * 读：`SELECT * FROM workbook ORDER BY updated_at DESC`——跨 workspace 隔离由 db 边界保证，
 *     行级权限由表 PERMISSIONS 兜底，查询不带任何鉴权过滤。
 * 写：create / rename 走 createRecord / updateRecord——DDL/写权限由 access 类型卡死，
 *     participant 触发的权限错误经 {@link describeWriteError} 翻成中文提示。
 */
export function createWorkbooksStore(deps: WorkbooksDeps) {
  const state: WorkbooksState = {
    loading: false,
    error: null,
    workbooks: [],
  };

  function emit(): void {
    deps.onChange?.({ loading: state.loading, error: state.error, workbooks: state.workbooks });
  }

  async function load(): Promise<void> {
    state.loading = true;
    state.error = null;
    emit();
    try {
      const records = await deps
        .getConn()
        .query<Record<string, unknown>>("SELECT * FROM workbook ORDER BY updated_at DESC");
      state.workbooks = records.map(recordToWorkbook);
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  async function createBlank(name: string): Promise<WorkbookRow | null> {
    state.error = null;
    try {
      const created = await deps
        .getConn()
        .createRecord<{ id: unknown } & Record<string, unknown>>("workbook", { name });
      const workbook = recordToWorkbook(created);
      state.workbooks = [workbook, ...state.workbooks];
      emit();
      return workbook;
    } catch (err) {
      state.error = describeWriteError(err);
      emit();
      return null;
    }
  }

  async function rename(id: RecordIdString | string, name: string): Promise<boolean> {
    state.error = null;
    try {
      await deps.getConn().updateRecord(String(id), { name });
      state.workbooks = state.workbooks.map((wb) => (wb.id === id ? { ...wb, name } : wb));
      emit();
      return true;
    } catch (err) {
      state.error = describeWriteError(err);
      emit();
      return false;
    }
  }

  return {
    get loading(): boolean { return state.loading; },
    get error(): string | null { return state.error; },
    get workbooks(): WorkbookRow[] { return state.workbooks; },
    load,
    createBlank,
    rename,
  };
}
