import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplatePackScripts } from "./index";

describe("template pack scripts", () => {
  test("空选择不播种任何模板包", async () => {
    await expect(
      loadTemplatePackScripts({
        selectedPacks: [],
        packsDir: join(tmpdir(), "directory-that-does-not-need-to-exist"),
      }),
    ).resolves.toEqual([]);
  });

  test("仅新增数据文件即可按部署配置顺序发现模板包", async () => {
    const packsDir = await mkdtemp(join(tmpdir(), "surreal-ck-template-packs-"));
    try {
      await writeFile(join(packsDir, "test-pack.surql"), "-- test pack", "utf8");
      await writeFile(join(packsDir, "claims-demo.surql"), "-- claims demo", "utf8");

      await expect(
        loadTemplatePackScripts({ selectedPacks: ["claims-demo", "test-pack"], packsDir }),
      ).resolves.toEqual([
        { name: "claims-demo", fileName: "claims-demo.surql", sql: "-- claims demo" },
        { name: "test-pack", fileName: "test-pack.surql", sql: "-- test pack" },
      ]);
    } finally {
      await rm(packsDir, { recursive: true });
    }
  });

  test("未知模板包返回明确错误", async () => {
    const packsDir = await mkdtemp(join(tmpdir(), "surreal-ck-template-packs-"));
    try {
      await expect(
        loadTemplatePackScripts({ selectedPacks: ["missing-pack"], packsDir }),
      ).rejects.toThrow("unknown template pack: missing-pack");
    } finally {
      await rm(packsDir, { recursive: true });
    }
  });

  test("拒绝可能越过模板包目录的非法包名", async () => {
    await expect(
      loadTemplatePackScripts({ selectedPacks: ["../outside"] }),
    ).rejects.toThrow("invalid template pack name: ../outside");
  });

  test("法律入门模板包可幂等重入且不覆盖未声明的结构字段", async () => {
    const [script] = await loadTemplatePackScripts({ selectedPacks: ["legal-starter"] });

    expect(script?.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(script?.sql).toContain("label = $input.label");
    expect(script?.sql).not.toContain("column_defs = $input.column_defs");
    for (const key of ["case", "entity", "compliance", "diligence", "asset"]) {
      expect(script?.sql).toContain(`key: "${key}"`);
    }
  });

  test("破产债权模板包声明至少五个数据驱动快捷任务并在幂等更新时保留", async () => {
    const [script] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
    const taskCount = script?.sql.match(/task_text:/g)?.length ?? 0;

    expect(taskCount).toBeGreaterThanOrEqual(5);
    expect(script?.sql).toContain('label: "筛选大额缺失材料"');
    expect(script?.sql).toContain('label: "生成审核进度看板"');
    expect(script?.sql).toContain('risk: "write"');
    expect(script?.sql).toContain("quick_tasks = $input.quick_tasks");
  });
});
