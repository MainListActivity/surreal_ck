import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../..");

describe("legacy desktop 源料已退役", () => {
  test("server/legacy 目录不存在（迁移源料全部清空）", () => {
    expect(existsSync(resolve(repoRoot, "server/legacy"))).toBe(false);
  });
});
