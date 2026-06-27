import type { GridColumnDef, RecordIdString } from "@surreal-ck/shared/rpc.types";
import { getSurreal } from "./surreal";
import {
  createWorkbooksStore,
  filterWorkbooksByQuery,
  type WorkbookRow,
  type WorkbooksSnapshot,
} from "./workbooks";

export { filterWorkbooksByQuery };
export type { WorkbookRow } from "./workbooks";

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
  createFromTemplate: (
    template: { id: RecordIdString | string; defaultName?: string; columns?: GridColumnDef[] },
    name?: string,
  ) => store.createFromTemplate(template, name),
  rename: (id: RecordIdString | string, name: string) => store.rename(id, name),
};
