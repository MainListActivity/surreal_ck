import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readScreen(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function readComponent(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
}

function readApp(): string {
  return readFileSync(fileURLToPath(new URL("../App.svelte", import.meta.url)), "utf8");
}

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, "m"));
  return match?.[1] ?? "";
}

function expectDeclaration(rule: string, property: string, value: string): void {
  expect(rule.replace(/\s+/g, " ")).toContain(`${property}: ${value}`);
}

describe("HR-01 workspace 首页布局骨架", () => {
  test("WorkspaceScreen 提供 100vh 三栏 shell，且 ActivityPanel 只在 home 页挂载", () => {
    const workspace = readScreen("WorkspaceScreen.svelte");
    const activity = readComponent("ActivityPanel.svelte");

    expect(workspace).toContain('class="workspace-shell"');
    const shell = cssRule(workspace, ".workspace-shell");
    expectDeclaration(shell, "display", "flex");
    expectDeclaration(shell, "height", "100vh");

    expect(workspace).toMatch(/import ActivityPanel from "\.\.\/components\/ActivityPanel\.svelte";/);
    expect(workspace).toMatch(/\{#if page === "home"\}\s*<ActivityPanel\s*\/>\s*\{\/if\}/);
    expect(workspace.match(/<ActivityPanel/g)).toHaveLength(1);

    const panel = cssRule(activity, ".activity-panel");
    expectDeclaration(panel, "width", "280px");
    expectDeclaration(panel, "flex-shrink", "0");
  });

  test("SideNav 是 220px 固定侧栏，导航滚动区与底部用户栏分离", () => {
    const sideNav = readComponent("SideNav.svelte");

    expect(sideNav).toContain('class="sidebar-top"');
    expect(sideNav).toContain('class="sidebar-nav"');
    expect(sideNav).toContain('class="sidebar-footer"');
    expect(sideNav).toContain('class="sidebar-userbar"');

    const aside = cssRule(sideNav, ".side-nav");
    expectDeclaration(aside, "width", "220px");
    expectDeclaration(aside, "flex-shrink", "0");

    const nav = cssRule(sideNav, ".sidebar-nav");
    expectDeclaration(nav, "flex", "1");
    expectDeclaration(nav, "overflow-y", "auto");

    const footer = cssRule(sideNav, ".sidebar-footer");
    expectDeclaration(footer, "flex-shrink", "0");

    const userbar = cssRule(sideNav, ".sidebar-userbar");
    expectDeclaration(userbar, "flex-shrink", "0");
  });

  test("HomeScreen 不再渲染 topbar 搜索或通知残留", () => {
    const home = readScreen("HomeScreen.svelte");

    expect(home).not.toContain('class="topbar"');
    expect(home).not.toContain('class="search"');
    expect(home).not.toMatch(/\.topbar\s*\{/);
    expect(home).not.toMatch(/\.search(?:\s|:|\.)/);
    expect(home).not.toContain("搜索工作簿");
    expect(home).not.toContain("通知功能待迁移");
    expect(home).toContain('class="content"');
    expect(home).toContain('class="workbook-table"');
  });
});

describe("HR-02 首页搜索状态提升", () => {
  test("SideNav 承载搜索输入，WorkspaceScreen 持有 query 并传给 HomeScreen", () => {
    const sideNav = readComponent("SideNav.svelte");
    const workspace = readScreen("WorkspaceScreen.svelte");
    const home = readScreen("HomeScreen.svelte");

    expect(sideNav).toMatch(/onsearchchange\?:\s*\(q:\s*string\)\s*=>\s*void/);
    expect(sideNav).toContain('placeholder="搜索工作簿..."');
    expect(sideNav).toMatch(/oninput=\{handleSearchInput\}/);
    expect(sideNav).toMatch(/onsearchchange\?\.\(value\)/);
    expectDeclaration(cssRule(sideNav, ".sidebar-search"), "width", "100%");

    expect(workspace).toMatch(/let query = \$state\(""\);/);
    expect(workspace).toMatch(/onsearchchange=\{\(q\) => \(query = q\)\}/);
    expect(workspace.match(/\{query\}/g)).toHaveLength(3);

    expect(home).toMatch(/query\?: string/);
    expect(home).not.toMatch(/let query = \$state/);
    expect(home).not.toContain('const query = ""');
    expect(home).toContain("filterHomeWorkbooks(workbooksStore.workbooks");
    expect(home).toContain("{ query, tab, currentUserId }");
  });
});

describe("HR-05 首页快捷操作与 AI 入口", () => {
  test("HomeScreen 渲染三张快捷操作卡片，空白工作簿走现有新建流程，导入文件显示 stub", () => {
    const home = readScreen("HomeScreen.svelte");

    expect(home).toContain('class="quick-actions"');
    expect(home).toContain("空白工作簿");
    expect(home).toContain("从模板创建");
    expect(home).toContain("导入文件");
    expect(home).toContain("敬请期待");
    expect(home).toContain('workbooksStore.createBlank("未命名工作簿")');
    expect(home).toContain("onopen?.(wb.id)");
    expect(home).toContain("handleImportClick");
  });

  test("HomeScreen 常驻 AI banner，并通过 onopenaichat 打开 AI 抽屉", () => {
    const home = readScreen("HomeScreen.svelte");

    expect(home).toMatch(/onopenaichat\?:\s*\(\)\s*=>\s*void/);
    expect(home).toContain('class="ai-banner"');
    expect(home).toContain("AI 能生成 SurrealQL");
    expect(home).toContain("直接操作数据表结构和数据");
    expect(home).toContain("开始对话");
    expect(home).toContain("onopenaichat?.()");
  });

  test("HomeScreen greeting 显示时段问候、可点击 workspace 名称和连接状态点", () => {
    const home = readScreen("HomeScreen.svelte");

    expect(home).toContain("homeGreetingForDate()");
    expect(home).toContain("getConnectionState()");
    expect(home).toContain("connectionDotPresentation(connectionState)");
    expect(home).toContain('class="workspace-title"');
    expect(home).toContain("onworkspaceclick?.()");
    expect(home).toContain('class={`conn-dot ${connectionDot.tone}`}');
    expect(home).toContain("SurrealDB 连接状态");
    expect(home).toContain("{connectionDot.label}");
  });

  test("WorkspaceScreen 和 App 把首页开始对话接到现有 AI drawer", () => {
    const workspace = readScreen("WorkspaceScreen.svelte");
    const app = readApp();

    expect(workspace).toMatch(/onopenaichat\?:\s*\(\)\s*=>\s*void/);
    expect(workspace.match(/onopenaichat=\{\(\) => onopenaichat\?\.\(\)\}/g)).toHaveLength(2);
    expect(app).toContain("function openAiDrawer(): void");
    expect(app).toContain("onopenaichat={openAiDrawer}");
  });
});
