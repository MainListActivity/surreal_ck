import { describe, expect, test } from "bun:test";
import { menuRegistry } from "./menu";

describe("menuRegistry — 顶栏菜单注册表", () => {
  test("含全部预期菜单项，id 唯一", () => {
    const ids = menuRegistry.map((m) => m.id);
    expect(ids).toEqual(["export", "print", "copyLink", "history", "delete"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("删除项标记 danger，其余不标", () => {
    expect(menuRegistry.find((m) => m.id === "delete")?.danger).toBe(true);
    expect(menuRegistry.find((m) => m.id === "export")?.danger).toBeUndefined();
  });

  test("每项 action 可调用（当前为 noop，不抛错）", () => {
    for (const item of menuRegistry) {
      expect(() => item.action()).not.toThrow();
    }
  });
});
