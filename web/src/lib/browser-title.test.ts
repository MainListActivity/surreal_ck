import { describe, expect, test } from "bun:test";
import { buildBrowserTitle } from "./browser-title";

describe("buildBrowserTitle", () => {
  test("为公开页面提供明确标题", () => {
    expect(buildBrowserTitle({ route: { kind: "home" } })).toBe("卯豆");
    expect(buildBrowserTitle({ route: { kind: "login" } })).toBe("登录 - 卯豆");
    expect(buildBrowserTitle({ route: { kind: "callback" } })).toBe("正在登录 - 卯豆");
    expect(buildBrowserTitle({ route: { kind: "form" } })).toBe("公开表单 - 卯豆");
    expect(buildBrowserTitle({ route: { kind: "form-success" } })).toBe("提交成功 - 卯豆");
  });

  test("工作区首页优先显示工作区名称", () => {
    expect(buildBrowserTitle({
      route: { kind: "workspace", slug: "acme", page: "home" },
      workspaceName: "破产案件组",
    })).toBe("破产案件组 - 卯豆");

    expect(buildBrowserTitle({
      route: { kind: "workspace", slug: "acme", page: "home" },
    })).toBe("acme - 卯豆");
  });

  test.each([
    ["docs", "我的文档"],
    ["templates", "模板库"],
    ["dashboard", "仪表盘"],
    ["admin", "工作区设置"],
    ["admin-console", "SQL 控制台"],
    ["settings", "个人设置"],
    ["trash", "回收站"],
  ] as const)("工作区 %s 页面显示页面名和工作区名", (page, label) => {
    expect(buildBrowserTitle({
      route: { kind: "workspace", slug: "acme", page },
      workspaceName: "破产案件组",
    })).toBe(`${label} - 破产案件组 - 卯豆`);
  });

  test("工作区仪表盘使用稳定页面名，避免跨工作区沿用旧仪表盘名称", () => {
    expect(buildBrowserTitle({
      route: { kind: "workspace", slug: "acme", page: "dashboard" },
      workspaceName: "破产案件组",
      dashboardTitle: "债权概览",
    })).toBe("仪表盘 - 破产案件组 - 卯豆");
  });

  test("编辑器按数据表、工作簿层级显示标题", () => {
    expect(buildBrowserTitle({
      route: { kind: "editor", slug: "acme", workbookId: "workbook:1", sheetId: "sheet:1" },
      workspaceName: "破产案件组",
      workbookName: "恒大债权",
      sheetName: "申报明细",
    })).toBe("申报明细 - 恒大债权 - 卯豆");
  });

  test("编辑器仪表盘使用仪表盘页名称", () => {
    expect(buildBrowserTitle({
      route: { kind: "editor", slug: "acme", workbookId: "workbook:1", sheetId: null },
      workbookName: "恒大债权",
      editorPageKind: "dashboard",
      dashboardTitle: "清偿进度",
    })).toBe("清偿进度 - 恒大债权 - 卯豆");
  });

  test("动态名称为空时不产生空标题段或暴露 record id", () => {
    expect(buildBrowserTitle({
      route: { kind: "editor", slug: "acme", workbookId: "workbook:secret", sheetId: null },
      workspaceName: "破产案件组",
      workbookName: "  ",
    })).toBe("工作簿 - 破产案件组 - 卯豆");
  });

  test("忽略与当前路由不匹配的异步 store 上下文", () => {
    expect(buildBrowserTitle({
      route: { kind: "workspace", slug: "new-space", page: "home" },
      workspaceSlug: "old-space",
      workspaceName: "旧工作区",
    })).toBe("new-space - 卯豆");

    expect(buildBrowserTitle({
      route: { kind: "editor", slug: "new-space", workbookId: "workbook:new", sheetId: "sheet:new" },
      workspaceSlug: "new-space",
      workspaceName: "新工作区",
      loadedWorkbookId: "workbook:old",
      workbookName: "旧工作簿",
      activeSheetId: "sheet:old",
      sheetName: "旧数据表",
    })).toBe("工作簿 - 新工作区 - 卯豆");

    expect(buildBrowserTitle({
      route: { kind: "editor", slug: "new-space", workbookId: "workbook:new", sheetId: "sheet:new" },
      loadedWorkbookId: "workbook:new",
      workbookName: "新工作簿",
      activeSheetId: "sheet:old",
      sheetName: "旧数据表",
    })).toBe("新工作簿 - 卯豆");
  });
});
