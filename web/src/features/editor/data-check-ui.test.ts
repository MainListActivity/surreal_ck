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
    expect(dialog).toContain("重复候选");
    expect(dialog).toContain("引用无法核验");
    expect(dialog).toContain("字段一致性");
  });

  test("模板页为管理员提供三类受限规则配置入口", async () => {
    const [templates, rulesDialog] = await Promise.all([
      read("../../screens/TemplatesScreen.svelte"),
      read("../../components/TemplateCheckRulesDialog.svelte"),
    ]);
    expect(templates).toContain("配置数据检查规则");
    expect(templates).toContain("canWriteSharedStructure");
    expect(rulesDialog).toContain("duplicate");
    expect(rulesDialog).toContain("reference_exists");
    expect(rulesDialog).toContain("consistency");
    expect(rulesDialog).toContain("不执行脚本或查询");
  });
});
