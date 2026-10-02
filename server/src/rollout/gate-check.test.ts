import { describe, expect, test } from "bun:test";
import { createRolloutGateChecker } from "./gate-check";

const fakeDb = (impl: (sql: string) => unknown) => async () => ({
  query: async (sql: string) => impl(sql),
});

describe("createRolloutGateChecker", () => {
  test("无开关行 / enabled 行 → enabled（缺省不收紧）", async () => {
    const empty = createRolloutGateChecker({ getSystemDb: fakeDb(() => [[]]) });
    await expect(empty("ws_x", "legal_content_access")).resolves.toBe("enabled");
    const enabled = createRolloutGateChecker({ getSystemDb: fakeDb(() => [["enabled"]]) });
    await expect(enabled("ws_x", "legal_research_ai")).resolves.toBe("enabled");
  });

  test("disabled 行 → disabled", async () => {
    const check = createRolloutGateChecker({ getSystemDb: fakeDb(() => [["disabled"]]) });
    await expect(check("ws_x", "legal_content_access")).resolves.toBe("disabled");
  });

  test("查询失败向上抛（fail closed 由调用方归一），不做缓存", async () => {
    let calls = 0;
    const check = createRolloutGateChecker({
      getSystemDb: fakeDb(() => {
        calls += 1;
        if (calls === 1) throw new Error("db down");
        return [["disabled"]];
      }),
    });
    await expect(check("ws_x", "legal_content_access")).rejects.toThrow("db down");
    // 第二次调用不返回缓存的 enabled/disabled——重新实查。
    await expect(check("ws_x", "legal_content_access")).resolves.toBe("disabled");
    expect(calls).toBe(2);
  });
});
