import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readScreen(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function readComponent(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
}

function readEditorFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../features/editor/${name}`, import.meta.url)), "utf8");
}

describe("首次价值04补缺 · 成员邀请产品路径", () => {
  test("首页「邀请协作者」按钮打开 InviteMemberDialog，不再只切工作区面板", () => {
    const home = readScreen("HomeScreen.svelte");

    expect(home).toContain('import InviteMemberDialog from "../components/InviteMemberDialog.svelte";');
    expect(home).toMatch(/class="invite-btn"[^>]*onclick=\{\(\) => \(inviteOpen = true\)\}/);
    expect(home).toMatch(/\{#if inviteOpen\}\s*<InviteMemberDialog onclose=\{\(\) => \(inviteOpen = false\)\} \/>\s*\{\/if\}/);
    // 邀请按钮不得再绑到工作区切换器
    const inviteBtn = home.match(/<button[^>]*class="invite-btn"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(inviteBtn).not.toContain("onworkspaceclick");
  });

  test("InviteMemberDialog 复用 controller 提交并展示后端拒绝错误", () => {
    const dialog = readComponent("InviteMemberDialog.svelte");

    expect(dialog).toContain('from "../lib/invite-member"');
    expect(dialog).toContain("controller.submit(form, workspaceSlug, getSurreal())");
    // 403 等后端拒绝以 role=alert 展示
    expect(dialog).toMatch(/form\.error[\s\S]*?role="alert"/);
    // 成员列表渲染当前成员
    expect(dialog).toContain("form.members as member");
  });
});

describe("首次价值04补缺 · 顶栏权限徽标", () => {
  test("EditorTopbar 用 accessLevel 区分三态，participant 不落「只读」分支", () => {
    const topbar = readEditorFile("EditorTopbar.svelte");

    expect(topbar).toContain("editorAccessLevel");
    // 「只读」只在真正无数据写权限（readonly）时出现
    expect(topbar).toMatch(/accessLevel === "readonly"[\s\S]*?只读/);
    // participant（structure-readonly）显示「结构只读」徽标而非「只读」
    expect(topbar).toContain('accessLevel === "structure-readonly"');
    expect(topbar).toContain("结构只读");
    // 保存态不再被结构权限劫持：「已保存」分支不再用 canWriteSharedStructure 门控
    expect(topbar).not.toMatch(/!canWriteSharedStructure\s*\}?\s*\n?\s*<WifiOff/);
  });
});

describe("首次价值04补缺 · ShareModal 不宣称可分享", () => {
  test("ShareModal 不含占位链接或复制按钮，只说明真实协作路径", () => {
    const modal = readEditorFile("modals/ShareModal.svelte");

    expect(modal).not.toContain("复制链接");
    expect(modal).not.toContain("surreal_ck://workbook");
    expect(modal).toContain("链接分享暂未开放");
  });
});
