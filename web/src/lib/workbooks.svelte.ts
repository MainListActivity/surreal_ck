import type { RecordIdString } from "@surreal-ck/shared/dto";
import { getSurreal } from "./surreal";
import { getCurrentWorkspace } from "./workspace-store.svelte";
import { loadWorkspaceQuota } from "./quota/client";
import {
  createWorkbooksStore,
  type CreateFromTemplateOptions,
  type CsvWorkbookImportInput,
  type XlsxWorkbookImportInput,
  type TemplateForCreate,
  type WorkbookRow,
  type WorkbooksSnapshot,
} from "./workbooks";

/**
 * Reactive mirror of the pure {@link createWorkbooksStore}. The logic layer
 * (unit-tested in workbooks.test.ts) holds the real state and emits snapshots;
 * this file republishes them into Svelte 5 runes so the workbook nav updates.
 */
const reactive = $state<WorkbooksSnapshot>({
  loading: false,
  error: null,
  workbooks: [],
});

const store = createWorkbooksStore({
  getConn: getSurreal,
  // CV02：建簿前按工作区配额视图预检实体表容量（所需/缺口提示）。
  // 读数不可得时返回 null，由引擎配额原子兜底。
  getWorkspaceQuotaView: async () => {
    const slug = getCurrentWorkspace()?.slug;
    if (!slug) return null;
    return loadWorkspaceQuota(slug);
  },
  onChange(snapshot) {
    reactive.loading = snapshot.loading;
    reactive.error = snapshot.error;
    reactive.workbooks = snapshot.workbooks;
  },
});

export const workbooksStore = {
  get loading(): boolean { return reactive.loading; },
  get error(): string | null { return reactive.error; },
  get workbooks(): WorkbookRow[] { return reactive.workbooks; },

  load: () => store.load(),
  createBlank: (name: string) => store.createBlank(name),
  importCsvWorkbook: (input: CsvWorkbookImportInput) => store.importCsvWorkbook(input),
  importXlsxWorkbook: (input: XlsxWorkbookImportInput) => store.importXlsxWorkbook(input),
  createFromTemplate: (
    template: TemplateForCreate,
    name?: string,
    options?: CreateFromTemplateOptions,
  ) => store.createFromTemplate(template, name, options),
  rename: (id: RecordIdString | string, name: string) => store.rename(id, name),
};
