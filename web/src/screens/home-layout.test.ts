import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readScreen(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function readComponent(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
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
