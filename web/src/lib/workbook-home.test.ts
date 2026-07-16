import { describe, expect, test } from "bun:test";
import type { WorkbookTemplate } from "@surreal-ck/shared/rpc.types";
import type { WorkbookRow } from "./workbooks";
import {
  WORKBOOK_VIEW_MODE_STORAGE_KEY,
  connectionDotPresentation,
  filterHomeWorkbooks,
  formatWorkbookUpdatedAt,
  getPinnedStorageKey,
  homeGreetingForDate,
  loadHomeMemberMetric,
  pinWorkbook,
  readPinnedWorkbooks,
  readWorkbookViewMode,
  workbookCardPresentation,
  writePinnedWorkbooks,
  writeWorkbookViewMode,
} from "./workbook-home";
import type { SurrealConn } from "./surreal";

const rows: WorkbookRow[] = [
  { id: "workbook:a", name: "案件台账", templateRef: "workbook_template:case", createdBy: "user:alice" },
  { id: "workbook:b", name: "财务汇总", createdBy: "user:bob" },
  { id: "workbook:c", name: "图谱分析", templateRef: "workbook_template:entity", createdBy: "user:alice" },
];

describe("filterHomeWorkbooks — 首页 tab 过滤", () => {
  test("先应用搜索，再按全部/我创建的/已固定过滤", () => {
    expect(filterHomeWorkbooks(rows, { query: "图谱", tab: "all", currentUserId: "user:alice" }).map((w) => w.id))
      .toEqual(["workbook:c"]);

    expect(filterHomeWorkbooks(rows, { query: "", tab: "mine", currentUserId: "user:alice" }).map((w) => w.id))
      .toEqual(["workbook:a", "workbook:c"]);

    expect(filterHomeWorkbooks(rows, {
      query: "财务",
      tab: "pinned",
      currentUserId: "user:alice",
      pinnedIds: ["workbook:a", "workbook:b"],
    }).map((w) => w.id)).toEqual(["workbook:b"]);
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

  test("展示从业务模板派生：模板的 icon/accent/label 驱动渲染，类型语义不在前端硬编码", () => {
    const caseTemplate: WorkbookTemplate = {
      id: "workbook_template:case", key: "case", label: "案件管理",
      icon: "scale", accent: "#CC6B3A", columnDefs: [], sheets: [], builtin: true, sortOrder: 10,
    };
    expect(workbookCardPresentation(caseTemplate)).toEqual({
      previewKind: "table",
      templateLabel: "案件管理",
      icon: "scale",
      accent: "#CC6B3A",
      soft: "#E7F0E4",
    });
  });

  test("network 类图标解析为 graph 预览；模板缺 accent 时回退内置配色", () => {
    const entityTemplate: WorkbookTemplate = {
      id: "workbook_template:entity", key: "entity", label: "实体追踪",
      icon: "network", columnDefs: [], sheets: [], builtin: true, sortOrder: 20,
    };
    const p = workbookCardPresentation(entityTemplate);
    expect(p.previewKind).toBe("graph");
    expect(p.templateLabel).toBe("实体追踪");
    expect(p.accent).toBe("#CC6B3A"); // graph 兜底 accent
  });

  test("无模板（templateRef 为空或模板已删）= 空白工作簿，不造类型语义", () => {
    expect(workbookCardPresentation(undefined)).toEqual({
      previewKind: "blank",
      templateLabel: "空白工作簿",
      accent: "#8C8472",
      soft: "#ECE7DB",
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

describe("loadHomeMemberMetric — 首页真实成员指标", () => {
  test("可读到真人成员时展示真实成员数", async () => {
    let capturedSql = "";
    const conn = {
      query: async (sql: string) => {
        capturedSql = sql;
        return [{ count: 3 }];
      },
    } as unknown as Pick<SurrealConn, "query">;

    await expect(loadHomeMemberMetric(conn)).resolves.toEqual({ value: 3, label: "位成员" });
    expect(capturedSql).toContain("FROM user");
    expect(capturedSql).toContain("kind = 'human'");
    expect(capturedSql).toContain("disabled_at = NONE");
    expect(capturedSql).not.toContain("$auth");
  });

  test("没有可见成员数据时返回隐藏态", async () => {
    const conn = {
      query: async () => [],
    } as unknown as Pick<SurrealConn, "query">;

    await expect(loadHomeMemberMetric(conn)).resolves.toBeNull();
  });

  test("成员查询失败时返回隐藏态而不影响首页", async () => {
    const conn = {
      query: async () => {
        throw new Error("Not enough permissions");
      },
    } as unknown as Pick<SurrealConn, "query">;

    await expect(loadHomeMemberMetric(conn)).resolves.toBeNull();
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
