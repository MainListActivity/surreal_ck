import { describe, expect, test } from "bun:test";
import { createCreateEntryController } from "./create-entry";

/**
 * 05a：workspace 下拉菜单「新建工作区」入口的纯逻辑层。
 * dropdown 是否显示入口 = canCreate；点击入口 → 关下拉 + 开对话框；
 * 创建成功 → 关对话框 + reload 列表 + 通知。取消 → 只关对话框，不 reload。
 */
function setup(opts: { canCreate?: boolean } = {}) {
  const calls = { reload: 0, created: 0 };
  const controller = createCreateEntryController({
    canCreate: () => opts.canCreate ?? false,
    reload: async () => {
      calls.reload += 1;
    },
    onCreated: () => {
      calls.created += 1;
    },
  });
  return { controller, calls };
}

describe("createCreateEntryController", () => {
  test("有创建权限：下拉显示入口", () => {
    const { controller } = setup({ canCreate: true });
    expect(controller.showEntry()).toBe(true);
  });

  test("无创建权限：下拉隐藏入口", () => {
    const { controller } = setup({ canCreate: false });
    expect(controller.showEntry()).toBe(false);
  });

  test("点击入口：关下拉 + 开对话框", () => {
    const { controller } = setup({ canCreate: true });
    const next = controller.openDialog({ dropdownOpen: true, dialogOpen: false });
    expect(next.dropdownOpen).toBe(false);
    expect(next.dialogOpen).toBe(true);
  });

  test("无权限时点击入口被忽略（不开对话框）", () => {
    const { controller } = setup({ canCreate: false });
    const next = controller.openDialog({ dropdownOpen: true, dialogOpen: false });
    expect(next.dialogOpen).toBe(false);
    expect(next.dropdownOpen).toBe(true);
  });

  test("创建成功：关对话框 + reload 列表 + 通知", async () => {
    const { controller, calls } = setup({ canCreate: true });
    const next = await controller.handleCreated();
    expect(next.dialogOpen).toBe(false);
    expect(calls.reload).toBe(1);
    expect(calls.created).toBe(1);
  });

  test("取消创建：只关对话框，不 reload、不通知", () => {
    const { controller, calls } = setup({ canCreate: true });
    const next = controller.closeDialog();
    expect(next.dialogOpen).toBe(false);
    expect(calls.reload).toBe(0);
    expect(calls.created).toBe(0);
  });
});
