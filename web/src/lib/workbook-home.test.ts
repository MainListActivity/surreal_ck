import { describe, expect, test } from "bun:test";
import type { WorkbookRow } from "./workbooks";
import {
  WORKBOOK_VIEW_MODE_STORAGE_KEY,
  connectionDotPresentation,
  filterHomeWorkbooks,
  formatWorkbookUpdatedAt,
  getPinnedStorageKey,
  homeGreetingForDate,
  pinWorkbook,
  readPinnedWorkbooks,
  readWorkbookViewMode,
  workbookCardPresentation,
  writePinnedWorkbooks,
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

describe("home greeting presentation — 首页问候与连接状态", () => {
  test("按当前小时输出早上好/下午好/晚上好", () => {
    expect(homeGreetingForDate(new Date("2026-06-13T08:00:00"))).toBe("早上好");
    expect(homeGreetingForDate(new Date("2026-06-13T14:00:00"))).toBe("下午好");
    expect(homeGreetingForDate(new Date("2026-06-13T21:00:00"))).toBe("晚上好");
  });

  test("open 显示已连接绿点，其它状态显示断开红点", () => {
    expect(connectionDotPresentation("open")).toEqual({
      label: "已连接",
      tone: "connected",
    });
    expect(connectionDotPresentation("closed")).toEqual({
      label: "已断开",
      tone: "disconnected",
    });
    expect(connectionDotPresentation("closing")).toEqual({
      label: "已断开",
      tone: "disconnected",
    });
  });
});

// --- pinned workbooks ---

type FakeStorage = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function makeFakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
}

describe("getPinnedStorageKey — key 按 workspace 隔离", () => {
  test("返回带 dbName 后缀的固定 key", () => {
    expect(getPinnedStorageKey("ws_abc")).toBe("surreal_ck.pinned_workbooks.ws_abc");
    expect(getPinnedStorageKey("ws_xyz")).toBe("surreal_ck.pinned_workbooks.ws_xyz");
  });
});

describe("readPinnedWorkbooks — 读 localStorage", () => {
  test("未写入时返回空数组", () => {
    const storage = makeFakeStorage();
    expect(readPinnedWorkbooks(storage, "ws_a")).toEqual([]);
  });

  test("能读出已写入的 id 列表", () => {
    const storage = makeFakeStorage();
    storage.store.set("surreal_ck.pinned_workbooks.ws_a", JSON.stringify(["workbook:1", "workbook:2"]));
    expect(readPinnedWorkbooks(storage, "ws_a")).toEqual(["workbook:1", "workbook:2"]);
  });

  test("JSON 损坏时回退空数组", () => {
    const storage = makeFakeStorage();
    storage.store.set("surreal_ck.pinned_workbooks.ws_a", "not-json{{{");
    expect(readPinnedWorkbooks(storage, "ws_a")).toEqual([]);
  });
});

describe("writePinnedWorkbooks — 写 localStorage", () => {
  test("把 id 数组序列化写入正确 key", () => {
    const storage = makeFakeStorage();
    writePinnedWorkbooks(storage, "ws_a", ["workbook:1", "workbook:2"]);
    expect(storage.store.get("surreal_ck.pinned_workbooks.ws_a")).toBe(
      JSON.stringify(["workbook:1", "workbook:2"]),
    );
  });
});

describe("pinWorkbook — 幂等固定工作簿", () => {
  test("未固定时追加 id 并返回新列表", () => {
    const storage = makeFakeStorage();
    const result = pinWorkbook(storage, "ws_a", "workbook:1");
    expect(result).toEqual(["workbook:1"]);
    expect(readPinnedWorkbooks(storage, "ws_a")).toEqual(["workbook:1"]);
  });

  test("重复固定同一 id 不重复追加（幂等）", () => {
    const storage = makeFakeStorage();
    pinWorkbook(storage, "ws_a", "workbook:1");
    const result = pinWorkbook(storage, "ws_a", "workbook:1");
    expect(result).toEqual(["workbook:1"]);
  });

  test("不同 workspace 的固定列表互不干扰", () => {
    const storage = makeFakeStorage();
    pinWorkbook(storage, "ws_a", "workbook:1");
    pinWorkbook(storage, "ws_b", "workbook:2");
    expect(readPinnedWorkbooks(storage, "ws_a")).toEqual(["workbook:1"]);
    expect(readPinnedWorkbooks(storage, "ws_b")).toEqual(["workbook:2"]);
  });
});
