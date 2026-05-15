import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXEC_TEMPLATE_IDS } from "./exec-template";

const root = process.cwd();
const schemaTemplateDir = join(root, "schema", "templates");

describe("远端 DDL 模板源", () => {
  test("根目录不再保留旧 templates 目录", () => {
    expect(existsSync(join(root, "templates"))).toBe(false);
  });

  test("execTemplate 使用的模板 id 都存在于 schema/templates", () => {
    for (const id of Object.values(EXEC_TEMPLATE_IDS)) {
      expect(existsSync(join(schemaTemplateDir, `${id}.sql`))).toBe(true);
    }
  });

  test("schema/templates 下的 SQL 模板不使用旧 {{placeholder}} 占位符", () => {
    const sqlFiles = readdirSync(schemaTemplateDir).filter((file) => file.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);

    for (const file of sqlFiles) {
      const content = readFileSync(join(schemaTemplateDir, file), "utf8");
      expect(content).not.toContain("{{");
      expect(content).not.toContain("}}");
    }
  });
});
