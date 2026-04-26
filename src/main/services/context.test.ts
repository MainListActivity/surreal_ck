import { describe, test, expect, beforeEach } from "bun:test";
import {
  getServiceContext,
  assertAuthenticated,
  assertWritable,
  setOfflineMode,
  getOfflineMode,
} from "./context";
import { ServiceError } from "./errors";

// 用于在测试中模拟 session 状态的辅助变量
// context.ts 通过 getSession() 判断认证状态；测试中需要控制其返回值。
// 由于 session.ts 使用模块级变量，我们 mock 整个 auth/session 模块。

import { mock } from "bun:test";

let _mockSession: { expiresAt: number } | null = null;

mock.module("../auth/session", () => ({
  getSession: () => _mockSession,
  getPublicAuthState: () =>
    _mockSession ? { loggedIn: true, expiresAt: _mockSession.expiresAt } : { loggedIn: false },
}));

beforeEach(() => {
  _mockSession = null;
  setOfflineMode(false);
});

describe("getServiceContext", () => {
  test("未登录时返回 isAuthenticated:false 且 readOnly:true", () => {
    const ctx = getServiceContext();
    expect(ctx.isAuthenticated).toBe(false);
    expect(ctx.readOnly).toBe(true);
  });

  test("已登录且在线时返回 isAuthenticated:true, readOnly:false", () => {
    _mockSession = { expiresAt: Date.now() + 3600_000 };
    const ctx = getServiceContext();
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.readOnly).toBe(false);
    expect(ctx.isOffline).toBe(false);
  });

  test("已登录但 offline 时返回 readOnly:true", () => {
    _mockSession = { expiresAt: Date.now() + 3600_000 };
    setOfflineMode(true);
    const ctx = getServiceContext();
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.readOnly).toBe(true);
    expect(ctx.isOffline).toBe(true);
  });
});

describe("assertAuthenticated", () => {
  test("未登录时抛出 NOT_AUTHENTICATED ServiceError", () => {
    try {
      assertAuthenticated();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("NOT_AUTHENTICATED");
    }
  });

  test("已登录时不抛出", () => {
    _mockSession = { expiresAt: Date.now() + 3600_000 };
    expect(() => assertAuthenticated()).not.toThrow();
  });
});

describe("assertWritable", () => {
  test("未登录时抛出 NOT_AUTHENTICATED ServiceError", () => {
    try {
      assertWritable();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("NOT_AUTHENTICATED");
    }
  });

  test("已登录但 offline 时抛出 OFFLINE_READ_ONLY ServiceError", () => {
    _mockSession = { expiresAt: Date.now() + 3600_000 };
    setOfflineMode(true);
    try {
      assertWritable();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("OFFLINE_READ_ONLY");
    }
  });

  test("已登录且在线时不抛出", () => {
    _mockSession = { expiresAt: Date.now() + 3600_000 };
    expect(() => assertWritable()).not.toThrow();
  });
});

describe("setOfflineMode", () => {
  test("可以切换离线状态", () => {
    expect(getOfflineMode()).toBe(false);
    setOfflineMode(true);
    expect(getOfflineMode()).toBe(true);
  });
});
