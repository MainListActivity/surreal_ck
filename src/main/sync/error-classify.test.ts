import { describe, expect, test } from "bun:test";
import { classifySyncError } from "./error-classify";

describe("同步错误分类", () => {
  test("连接、超时、5xx 属于 transient", () => {
    expect(classifySyncError(new Error("network timeout"))).toBe("transient");
    expect(classifySyncError(new Error("HTTP 503 Service Unavailable"))).toBe("transient");
    expect(classifySyncError(new Error("AuthenticationFailed"))).toBe("transient");
  });

  test("权限、ASSERT、引用错误属于 semantic", () => {
    expect(classifySyncError(new Error("PERMISSIONS: Not enough permissions"))).toBe("semantic");
    expect(classifySyncError(new Error("Found field name for app_setting, with record value ASSERT failed"))).toBe("semantic");
    expect(classifySyncError(new Error("The record reference does not exist"))).toBe("semantic");
  });
});
