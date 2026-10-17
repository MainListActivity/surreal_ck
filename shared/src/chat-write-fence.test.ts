/**
 * 写栅栏共享契约（PG-1）。
 *
 * 覆盖三处真正的风险点：键的生成与归一、同一 run 第二次暂停不被第一次的键吞掉、
 * 老快照（无 payload.suspendKey）仍能退化出可用键、具名错误文案稳定。
 */
import { describe, expect, test } from "bun:test";
import {
  CHAT_WRITE_FENCE_ERRORS,
  chatWriteFenceMessage,
  suspendPathKey,
  suspendPathKeyFromSnapshot,
  suspendPathKeyFromState,
} from "./chat-write-fence";

describe("suspendPathKey", () => {
  test("键格式为 `<stepId>#<seq>`，同一次暂停恒等", () => {
    expect(suspendPathKey("execute-one", 0)).toBe("execute-one#0");
    expect(suspendPathKey("execute-one", 3)).toBe("execute-one#3");
    expect(suspendPathKey("finalize", 1)).toBe("finalize#1");
    // 纯函数：同样入参永远同键——stream 与 recover 两侧靠这个对齐。
    expect(suspendPathKey("execute-one", 2)).toBe(suspendPathKey("execute-one", 2));
  });

  test("同一 plan item 的第二次暂停必须拿到不同键（否则栅栏永不重开）", () => {
    // 这是改用递增序号而非 plan cursor 的原因：cursor 相同，seq 不同。
    expect(suspendPathKey("execute-one", 1)).not.toBe(suspendPathKey("execute-one", 2));
  });

  test("缺失 / 非法序号归一为 0，空 stepId 归一为 execute-one", () => {
    expect(suspendPathKey("execute-one", Number.NaN)).toBe("execute-one#0");
    expect(suspendPathKey("execute-one", -5)).toBe("execute-one#0");
    expect(suspendPathKey("execute-one", 2.9)).toBe("execute-one#2");
    expect(suspendPathKey("   ", 0)).toBe("execute-one#0");
  });
});

/** 一份 workflow_run.state 形态的快照；step 结果可为数组（dountil 逐步结果）。 */
function snapshot(entries: Record<string, unknown[]>): unknown {
  return { context: entries };
}

function suspendedStep(suspendKey: string | undefined, opts: { index?: number; suspendedAt?: number; extra?: Record<string, unknown> } = {}) {
  return {
    status: "suspended",
    suspendedAt: opts.suspendedAt ?? 1,
    ...(opts.index === undefined ? {} : { foreachIndex: opts.index }),
    suspendPayload: { kind: "await-write-confirm", ...(suspendKey ? { suspendKey } : {}), ...opts.extra },
  };
}

describe("suspendPathKeyFromSnapshot", () => {
  test("payload 里的 suspendKey 是权威来源", () => {
    const state = snapshot({ "execute-one": [suspendedStep("execute-one#4", { index: 0 })] });
    // 即使 foreachIndex 是 0，也必须取 payload 的键——否则第二次暂停会被误判成第一次。
    expect(suspendPathKeyFromSnapshot(state)).toBe("execute-one#4");
  });

  test("payload 键缺席（老 run）时退回按 foreachIndex 取最大游标", () => {
    const state = snapshot({
      "execute-one": [
        suspendedStep(undefined, { index: 0, suspendedAt: 1 }),
        suspendedStep(undefined, { index: 2, suspendedAt: 2 }),
      ],
    });
    expect(suspendPathKeyFromSnapshot(state)).toBe("execute-one#2");
  });

  test("多个 step 各自带键时取最近一次挂起（suspendedAt 最大）", () => {
    const state = snapshot({
      "execute-one": [suspendedStep("execute-one#0", { suspendedAt: 10 })],
      finalize: [suspendedStep("finalize#1", { suspendedAt: 20 })],
    });
    expect(suspendPathKeyFromSnapshot(state)).toBe("finalize#1");
  });

  test("state 以 JSON 字符串形态存储时同样可解析", () => {
    const state = JSON.stringify(snapshot({ "execute-one": [suspendedStep("execute-one#2")] }));
    expect(suspendPathKeyFromSnapshot(state)).toBe("execute-one#2");
  });

  test("无 suspended 痕迹 / 结构非法时返回 undefined，由调用方回落", () => {
    expect(suspendPathKeyFromSnapshot(undefined)).toBeUndefined();
    expect(suspendPathKeyFromSnapshot({})).toBeUndefined();
    expect(suspendPathKeyFromSnapshot({ context: {} })).toBeUndefined();
    // 非 suspended 的结果不算挂起痕迹。
    expect(suspendPathKeyFromSnapshot(snapshot({ "execute-one": [{ status: "success" }] }))).toBeUndefined();
  });
});

describe("suspendPathKeyFromState", () => {
  test("有 state 时以 state 为准，无 state 时按传入的 stepId/cursor 退化", () => {
    const state = snapshot({ "execute-one": [suspendedStep("execute-one#7")] });
    expect(suspendPathKeyFromState({ state })).toBe("execute-one#7");
    expect(suspendPathKeyFromState({ stepId: "execute-one", cursor: 3 })).toBe("execute-one#3");
    expect(suspendPathKeyFromState({})).toBe("execute-one#0");
  });
});

describe("具名拒绝", () => {
  test("三个 code 各自有稳定中文文案，绝不回落成通用错误", () => {
    for (const code of Object.values(CHAT_WRITE_FENCE_ERRORS)) {
      const message = chatWriteFenceMessage(code);
      expect(message).toBeTruthy();
      // 文案必须说明「没有写入」，否则用户无法判断是否已落库。
      expect(message).toContain("没有写入任何数据");
    }
  });

  test("未知 / 缺席 code 返回 null（不是通用文案）", () => {
    expect(chatWriteFenceMessage(undefined)).toBeNull();
    expect(chatWriteFenceMessage(null)).toBeNull();
    expect(chatWriteFenceMessage("some-other-error")).toBeNull();
  });

  test("已消费与 run 终态是两个不同 code，提示不同", () => {
    expect(CHAT_WRITE_FENCE_ERRORS.consumed).not.toBe(CHAT_WRITE_FENCE_ERRORS.runEnded);
    expect(chatWriteFenceMessage(CHAT_WRITE_FENCE_ERRORS.runEnded)).toContain("运行已结束");
  });
});