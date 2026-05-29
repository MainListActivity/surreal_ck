import { describe, expect, test } from "bun:test";
import { cardAccent, cardPillStyle, statusTone } from "./cell-style";

describe("statusTone — 按文本判定状态色调", () => {
  test("通过/完成/active → success", () => {
    expect(statusTone("已通过")).toBe("success");
    expect(statusTone("完成")).toBe("success");
    expect(statusTone("ACTIVE")).toBe("success");
  });

  test("审核中/pending → info", () => {
    expect(statusTone("审核中")).toBe("info");
    expect(statusTone("pending")).toBe("info");
  });

  test("退回/拒绝/失败/error → error", () => {
    expect(statusTone("已退回")).toBe("error");
    expect(statusTone("拒绝")).toBe("error");
    expect(statusTone("error")).toBe("error");
  });

  test("其它（含空值）→ warning", () => {
    expect(statusTone("草稿")).toBe("warning");
    expect(statusTone(null)).toBe("warning");
    expect(statusTone(undefined)).toBe("warning");
  });
});

describe("cardAccent / cardPillStyle — 把色调编成 CSS 变量", () => {
  test("cardAccent 引用对应色调变量", () => {
    expect(cardAccent("完成")).toBe("var(--success)");
    expect(cardAccent("草稿")).toBe("var(--warning)");
  });

  test("cardPillStyle 同时给出底色与文字色", () => {
    expect(cardPillStyle("pending")).toBe("--pill-bg:var(--info-bg);--pill-color:var(--info)");
  });
});
