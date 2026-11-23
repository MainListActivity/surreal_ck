import { expect, test } from "bun:test";
import { join } from "node:path";

test("维护围栏关闭公开写入、保留鉴权后的验收入口并失败关闭", () => {
  const result = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../../../scripts/deploy/maintenance-fence/test_fence.py")]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
