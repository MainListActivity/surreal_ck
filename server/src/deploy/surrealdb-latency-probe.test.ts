import { expect, test } from "bun:test";
import { join } from "node:path";

test("维护延迟探针隔离读写、凭证保护、清理与基线比较失败关闭", () => {
  const result = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../../../scripts/deploy/surrealdb-latency-probe.test.py")]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 30_000);
