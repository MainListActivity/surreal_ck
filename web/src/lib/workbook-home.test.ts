import { describe, expect, test } from "bun:test";
import type { WorkbookRow } from "./workbooks";
import {
  WORKBOOK_VIEW_MODE_STORAGE_KEY,
  filterHomeWorkbooks,
  formatWorkbookUpdatedAt,
  readWorkbookViewMode,
  workbookCardPresentation,
  writeWorkbookViewMode,
} from "./workbook-home";

const rows: WorkbookRow[] = [
  { id: "workbook:a", name: "案件台账", templateKey: "claims", createdBy: "user:alice" },
  { id: "workbook:b", name: "财务汇总", templateKey: "finance", createdBy: "user:bob" },
  { id: "workbook:c", name: "图谱分析", templateKey: "graph", createdBy: "user:alice" },
];

describe("filterHomeWorkbooks — 首页 tab 过滤", () => {
  test("先应用搜索，再按全部/我创建的/与我共享过滤", () => {
    expect(filterHomeWorkbooks(rows, { query: "图谱", tab: "all", currentUserId: "user:alice" }).map((w) => w.id))
      .toEqual(["workbook:c"]);

    expect(filterHomeWorkbooks(rows, { query: "", tab: "mine", currentUserId: "user:alice" }).map((w) => w.id))
      .toEqual(["workbook:a", "workbook:c"]);

    expect(filterHomeWorkbooks(rows, { query: "", tab: "shared", currentUserId: "user:alice" }))
      .toEqual([]);
  });
});

describe("workbook view mode — 首页视图偏好", () => {
  test("默认网格视图，合法值可恢复，非法值回退网格", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    };

    expect(readWorkbookViewMode(storage)).toBe("grid");

    writeWorkbookViewMode(storage, "list");
    expect(store.get(WORKBOOK_VIEW_MODE_STORAGE_KEY)).toBe("list");
    expect(readWorkbookViewMode(storage)).toBe("list");

    store.set(WORKBOOK_VIEW_MODE_STORAGE_KEY, "kanban");
    expect(readWorkbookViewMode(storage)).toBe("grid");
  });
});

describe("workbook card presentation — 卡片展示模型", () => {
  test("updatedAt 输出中文相对时间", () => {
    const now = new Date("2026-06-13T12:00:00");

    expect(formatWorkbookUpdatedAt("2026-06-13T08:40:00", now)).toBe("3 小时前");
    expect(formatWorkbookUpdatedAt("2026-06-12T18:00:00", now)).toBe("昨天");
    expect(formatWorkbookUpdatedAt(undefined, now)).toBe("—");
  });

  test("templateKey 映射为可区分的预览类型和状态标签", () => {
    expect(workbookCardPresentation("claims")).toEqual({
      previewKind: "table",
      statusLabel: "进行中",
      templateLabel: "债权台账",
    });
    expect(workbookCardPresentation("graph")).toEqual({
      previewKind: "graph",
      statusLabel: "待审核",
      templateLabel: "关系图谱",
    });
    expect(workbookCardPresentation(undefined)).toEqual({
      previewKind: "blank",
      statusLabel: "草稿",
      templateLabel: "空白工作簿",
    });
  });
});
