import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("全范围数据体检界面", () => {
  test("工具栏可启动体检，界面区分进度、问题、取消、待重检和完整无问题", async () => {
    const [toolbar, dialog, screen] = await Promise.all([
      read("EditorToolbar.svelte"),
      read("modals/DataCheckDialog.svelte"),
      read("../../screens/EditorScreen.svelte"),
    ]);
    expect(toolbar).toContain("数据体检");
    expect(toolbar).toContain("showDataCheck = true");
    expect(screen).toContain("<DataCheckDialog />");
    expect(dialog).toContain("不受当前 500 条视图窗口限制");
    expect(dialog).toContain("取消检查");
    expect(dialog).toContain("结果待重检");
    expect(dialog).toContain("完整扫描范围内未发现问题");
    expect(dialog).toContain("定位记录");
  });
});
