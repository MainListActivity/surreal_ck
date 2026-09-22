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

describe("WS-03 工作区基本信息区块", () => {
  test("设置页展示工作区 name / slug / role，并把改名成功回写 workspace-store", () => {
    const settings = readScreen("WorkspaceSettingsScreen.svelte");

    expect(settings).toMatch(/import \{ renameWorkspace \} from "\.\.\/lib\/workspace-meta-data";/);
    expect(settings).toMatch(/setCurrentWorkspaceName/);
    expect(settings).toContain('aria-label="基本信息"');
    expect(settings).toContain("显示名称");
    expect(settings).toContain("Slug");
    expect(settings).toContain("当前角色");
    expect(settings).toMatch(/const result = await renameWorkspace\(workspaceSlug, workspaceNameDraft\);/);
    expect(settings).toMatch(/syncedWorkspaceName = result\.name;/);
    expect(settings).toMatch(/setCurrentWorkspaceName\(result\.name\);/);
  });

  test("基本信息保存入口只对管理员开放，空名或未改动不可保存", () => {
    const settings = readScreen("WorkspaceSettingsScreen.svelte");

    expect(settings).toMatch(/const canSaveWorkspaceName = \$derived\([\s\S]*trimmedWorkspaceName\.length > 0[\s\S]*workspaceNameDirty/);
    expect(settings).toMatch(/\{#if canManage\}\s*<button[\s\S]*type="submit"[\s\S]*disabled=\{!canSaveWorkspaceName\}[\s\S]*保存[\s\S]*<\/button>\s*\{\/if\}/);
  });
});

describe("运营摘要主动共享", () => {
  test("管理员先预览白名单字段，再明确共享或撤回", () => {
    const settings = readScreen("WorkspaceSettingsScreen.svelte");

    expect(settings).toContain('aria-label="运营摘要共享"');
    expect(settings).toContain("不会共享文件名、案件、正文、材料或成员邮箱");
    expect(settings).toContain("确认共享");
    expect(settings).toContain("撤回共享");
    expect(settings).toContain("契约 v2");
    expect(settings).toContain("未知（缺少可靠证据）");
    expect(settings).toContain("固定运行问题解决率");
    expect(settings).toContain("结果待核实");
    expect(settings).toContain("逐指标口径与来源");
    expect(settings).toContain("summaryPreview.progress.checks.definition");
    expect(settings).toMatch(/\{#if canManage\}[\s\S]*aria-label="运营摘要共享"/);
  });
});
