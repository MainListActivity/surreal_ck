import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readScreen(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function readComponent(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
}

describe("WS-01 工作区设置页接入", () => {
  test("admin page 渲染工作区设置页，settings page 仍保留个人设置", () => {
    const workspace = readScreen("WorkspaceScreen.svelte");

    expect(workspace).toMatch(/import WorkspaceSettingsScreen from "\.\/WorkspaceSettingsScreen\.svelte";/);
    expect(workspace).toMatch(/\{:else if page === "admin"\}\s*<WorkspaceSettingsScreen\s*\/>/);
    expect(workspace).toMatch(/\{:else if page === "settings"\}\s*<ProfileScreen\s*\/>/);
    expect(workspace).not.toContain("工作区设置待迁移");
  });

  test("侧栏工作区设置入口只在管理员条件下显示", () => {
    const sideNav = readComponent("SideNav.svelte");

    expect(sideNav).toMatch(
      /\{#if canOpenAdminConsole\}\s*<button[\s\S]*class:active=\{page === "admin"\}[\s\S]*工作区设置[\s\S]*<\/button>\s*\{\/if\}/,
    );
  });
});
