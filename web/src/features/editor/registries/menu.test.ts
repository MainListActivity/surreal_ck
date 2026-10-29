import { describe, expect, test } from "bun:test";
import { buildMenuRegistry } from "./menu";

const handlers = { exportCsv: () => {} };

describe("menuRegistry — 顶栏菜单注册表", () => {
  test("含全部预期菜单项，id 唯一", () => {
    const ids = buildMenuRegistry(handlers).map((m) => m.id);
    expect(ids).toEqual(["export", "print", "copyLink", "history", "delete"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("删除项标记 danger，其余不标", () => {
    const menu = buildMenuRegistry(handlers);
    expect(menu.find((m) => m.id === "delete")?.danger).toBe(true);
    expect(menu.find((m) => m.id === "export")?.danger).toBeUndefined();
  });

  test("导出项是 CSV 而非 Excel，且调用注入的 handler", () => {
    let called = 0;
    const menu = buildMenuRegistry({ exportCsv: () => { called += 1; } });
    const exportItem = menu.find((m) => m.id === "export");
    expect(exportItem?.label).toBe("导出为 CSV");
    expect(exportItem?.label).not.toContain("Excel");
    exportItem?.action();
    expect(called).toBe(1);
  });

  test("其余 action 仍为 noop，不抛错", () => {
    for (const item of buildMenuRegistry(handlers).filter((m) => m.id !== "export")) {
      expect(() => item.action()).not.toThrow();
    }
  });
});
