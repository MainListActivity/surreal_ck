import { expect, test } from "bun:test";
import { join } from "node:path";

test("维护围栏仅改写数据库兜底、隔离所有写入者并失败关闭", () => {
  const result = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../../../scripts/deploy/maintenance-fence/test_fence.py")]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
