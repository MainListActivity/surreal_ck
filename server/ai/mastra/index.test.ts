import { beforeEach, describe, expect, test } from "bun:test";
import { getMastra, initMastraForCurrentUser, resetMastra } from "./index";

function fakeSession() {
  return {
    query: async () => [[]],
  };
}

describe("Mastra 入口初始化", () => {
  beforeEach(() => {
    resetMastra();
  });

  test("未初始化时 getMastra 明确报错", () => {
    expect(() => getMastra()).toThrow("Mastra not initialized");
  });

  test("每次 initMastraForCurrentUser 都创建新实例，避免复用上一个会话 resolver", () => {
    const first = initMastraForCurrentUser(() => fakeSession() as never);
    const second = initMastraForCurrentUser(() => fakeSession() as never);

    expect(second).not.toBe(first);
    expect(getMastra()).toBe(second);
  });
});
