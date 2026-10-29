import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { workspaceKey } from "./hash";

describe("workspaceKey", () => {
  test("HMAC-SHA256 十六进制摘要，与 node:crypto 直接计算一致", () => {
    const expected = createHmac("sha256", "test-hash-key-0123456789").update("sck-demo-1234").digest("hex");
    expect(workspaceKey("sck-demo-1234", "test-hash-key-0123456789")).toBe(expected);
    expect(workspaceKey("sck-demo-1234", "test-hash-key-0123456789")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("同一输入同密钥稳定，不同密钥不同值（轮换会破坏历史对齐）", () => {
    const first = workspaceKey("sck-demo-1234", "test-hash-key-0123456789");
    expect(workspaceKey("sck-demo-1234", "test-hash-key-0123456789")).toBe(first);
    expect(workspaceKey("sck-demo-1234", "other-hash-key-0123456789")).not.toBe(first);
  });

  test("密钥为空返回 null（聚合任务不得写入）", () => {
    expect(workspaceKey("sck-demo-1234", "")).toBeNull();
  });
});
