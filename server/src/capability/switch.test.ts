import { describe, expect, test } from "bun:test";
import { evaluateCapabilitySwitch, readSwitchRow } from "./switch";
import type { Queryable } from "./switch";

/**
 * LCA-14 灰度开关求值：_system 行缺失 = on；off 一律拒绝；cohort 按
 * workspace slug 白名单放行。开关行读失败由调用方 fail closed。
 */
function fakeSystem(row: unknown, slug: string | null = "ws-alpha"): Queryable {
  return {
    async query(sql: string, params?: Record<string, unknown>) {
      expect(sql).toContain("LET $sw");
      expect(String(params?.switch)).toContain("platform_capability_switch");
      expect(params?.db).toBe("ws_alpha_db");
      return [null, null, { mode: (row as { mode?: string } | null)?.mode ?? "on",
        workspaces: (row as { workspaces?: string[] } | null)?.workspaces ?? [], slug }];
    },
  };
}

describe("evaluateCapabilitySwitch", () => {
  test("开关行缺失 → on（不改变未初始化部署的既有行为）", async () => {
    expect(await evaluateCapabilitySwitch(fakeSystem(null), "content", "ws_alpha_db")).toEqual({ allowed: true, mode: "on" });
  });

  test("mode=off → 全部拒绝", async () => {
    const d = await evaluateCapabilitySwitch(fakeSystem({ mode: "off" }), "ai", "ws_alpha_db");
    expect(d.allowed).toBe(false);
  });

  test("mode=cohort：白名单内 slug 放行，名单外拒绝", async () => {
    const row = { mode: "cohort", workspaces: ["ws-alpha", "ws-beta"] };
    expect((await evaluateCapabilitySwitch(fakeSystem(row, "ws-alpha"), "content", "ws_alpha_db")).allowed).toBe(true);
    expect((await evaluateCapabilitySwitch(fakeSystem(row, "ws-gamma"), "content", "ws_alpha_db")).allowed).toBe(false);
  });

  test("cohort 模式下 workspace slug 解析不到 → 拒绝（fail closed）", async () => {
    const row = { mode: "cohort", workspaces: ["ws-alpha"] };
    expect((await evaluateCapabilitySwitch(fakeSystem(row, null), "content", "ws_alpha_db")).allowed).toBe(false);
  });

  test("读失败上抛（调用方映射 503 fail closed）", async () => {
    const broken: Queryable = { async query() { throw new Error("system db down"); } };
    await expect(evaluateCapabilitySwitch(broken, "ai", "ws_alpha_db")).rejects.toThrow("system db down");
  });
});

describe("readSwitchRow", () => {
  test("解析开关行与缺失字段兜底", () => {
    expect(readSwitchRow([[{ mode: "cohort", workspaces: ["a"], note: "wave-1", updated_by: "op", updated_at: "2026-10-02" }]]))
      .toEqual({ mode: "cohort", workspaces: ["a"], note: "wave-1", updated_by: "op", updated_at: "2026-10-02" });
    expect(readSwitchRow([[]])).toBeNull();
    expect(readSwitchRow([[{ mode: "bogus" }]])).toBeNull();
  });
});
