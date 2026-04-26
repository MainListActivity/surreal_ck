import { describe, test, expect } from "bun:test";
import { ServiceError, toAppError, toAppOk, catchToAppError, withResult } from "./errors";

describe("toAppOk", () => {
  test("包装 payload 为成功结构", () => {
    const result = toAppOk({ id: "user:1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: "user:1" });
    }
  });
});

describe("toAppError", () => {
  test("已知 code 使用默认 message", () => {
    const err = toAppError("NOT_AUTHENTICATED");
    expect(err.ok).toBe(false);
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(err.message.length).toBeGreaterThan(0);
  });

  test("自定义 message 覆盖默认值", () => {
    const err = toAppError("VALIDATION_ERROR", "sub 字段缺失");
    expect(err.message).toBe("sub 字段缺失");
  });
});

describe("catchToAppError", () => {
  test("ServiceError 保留原始 code 和 message", () => {
    const svcErr = new ServiceError("OFFLINE_READ_ONLY", "离线中");
    const result = catchToAppError(svcErr);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("OFFLINE_READ_ONLY");
    expect(result.message).toBe("离线中");
  });

  test("普通 Error 映射为 INTERNAL_ERROR，不包含 stack", () => {
    const err = new Error("raw db error with stack");
    const result = catchToAppError(err);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result).not.toHaveProperty("stack");
  });

  test("空 message 的 Error 返回默认用户可读 message", () => {
    const err = new Error("");
    const result = catchToAppError(err);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("非 Error 值映射为 INTERNAL_ERROR", () => {
    const result = catchToAppError("something went wrong");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

describe("withResult", () => {
  test("成功时返回 ok:true", async () => {
    const result = await withResult(async () => ({ id: "1" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ id: "1" });
  });

  test("抛出 ServiceError 时返回对应错误码", async () => {
    const result = await withResult(async () => {
      throw new ServiceError("NOT_AUTHENTICATED");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_AUTHENTICATED");
  });

  test("抛出普通 Error 时返回 INTERNAL_ERROR", async () => {
    const result = await withResult(async () => {
      throw new Error("db crash");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INTERNAL_ERROR");
  });
});
