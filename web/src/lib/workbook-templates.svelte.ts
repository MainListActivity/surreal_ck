import type { WorkbookTemplate } from "@surreal-ck/shared/rpc.types";
import { getSurreal } from "./surreal";
import {
  createWorkbookTemplatesStore,
  type WorkbookTemplatesSnapshot,
} from "./workbook-templates";

export { templateColumnDefs, templateSheetsForCreate } from "./workbook-templates";
export type { WorkbookTemplate } from "@surreal-ck/shared/rpc.types";

/**
 * Reactive mirror of the pure {@link createWorkbookTemplatesStore}. 纯逻辑层持有真实状态并
 * emit 快照，这里把它转入 Svelte 5 runes，供首页 / 模板选择页响应式更新。
 */
const reactive = $state<WorkbookTemplatesSnapshot>({
  loading: false,
  error: null,
  templates: [],
});

const store = createWorkbookTemplatesStore({
  getConn: getSurreal,
  onChange(snapshot) {
    reactive.loading = snapshot.loading;
    reactive.error = snapshot.error;
    reactive.templates = snapshot.templates;
  },
});

export const workbookTemplatesStore = {
  get loading(): boolean { return reactive.loading; },
  get error(): string | null { return reactive.error; },
  get templates(): WorkbookTemplate[] { return reactive.templates; },

  load: () => store.load(),
  byKey: (key: string) => store.byKey(key),
};
