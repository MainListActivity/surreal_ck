import { expect, test } from "bun:test";
import { join } from "node:path";

test("只读延迟探针枚举、采样、凭证保护与基线比较失败关闭", () => {
  const result = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../../../scripts/deploy/surrealdb-latency-probe.test.py")]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
