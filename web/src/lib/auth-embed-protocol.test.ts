import { describe, expect, test } from "bun:test";
import { sanitizeReturnTo } from "./auth-embed-protocol";

describe("sanitizeReturnTo", () => {
  test("接受普通的站内路径", () => {
    expect(sanitizeReturnTo("/")).toBe("/");
    expect(sanitizeReturnTo("/workspaces/abc")).toBe("/workspaces/abc");
  });

  test("保留路径上的查询串", () => {
    expect(sanitizeReturnTo("/tables?focus=grid")).toBe("/tables?focus=grid");
  });

  test("拒绝 null、空串与非斜杠开头", () => {
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
    expect(sanitizeReturnTo("https://evil.example")).toBe("/");
    expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
  });

  test("拒绝协议相对 URL", () => {
    expect(sanitizeReturnTo("//evil.example/x")).toBe("/");
  });

  test("拒绝 auth 自身路由，避免回调循环", () => {
    expect(sanitizeReturnTo("/auth/login")).toBe("/");
    expect(sanitizeReturnTo("/auth/callback")).toBe("/");
    expect(sanitizeReturnTo("/auth/embed")).toBe("/");
    expect(sanitizeReturnTo("/auth/login?returnTo=%2F")).toBe("/");
  });

  test("允许同前缀的其他路径", () => {
    expect(sanitizeReturnTo("/auth/logout-all")).toBe("/auth/logout-all");
  });
});
