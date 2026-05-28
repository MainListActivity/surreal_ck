import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../..");

describe("D1-06 legacy mastra 已退役", () => {
  test("server/legacy/ai/mastra 目录不存在", () => {
    expect(existsSync(resolve(repoRoot, "server/legacy/ai/mastra"))).toBe(false);
  });

  test("server/legacy/ai/navigation-agent.test.ts 已删除", () => {
    expect(
      existsSync(resolve(repoRoot, "server/legacy/ai/navigation-agent.test.ts")),
    ).toBe(false);
  });

  test("server/legacy/ai 目录不存在（仅供 Mastra 用的支撑代码已清空）", () => {
    expect(existsSync(resolve(repoRoot, "server/legacy/ai"))).toBe(false);
  });
});
