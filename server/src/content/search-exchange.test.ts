import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./search-exchange";

/**
 * LCA-14 返工 D4：检索换票的目录扫描从逐条串行 await 改为有界并发，
 * 消除 O(N) 往返线性放大（生产实测 ~25s）。这些用例钉住并发上限、
 * 顺序保持与错误传播——不放宽任何授权语义（授权判定仍在逐条 plan 阶段）。
 */
describe("mapWithConcurrency（D4 有界并发）", () => {
  test("并发上限被严格遵守，结果顺序与输入一致", async () => {
    let inflight = 0;
    let peak = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = await mapWithConcurrency(items, async (i) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return i * 2;
    });
    expect(peak).toBe(32); // EXCHANGE_CONCURRENCY
    expect(out).toEqual(items.map((i) => i * 2));
  });

  test("任一项抛错即整体失败（调用方映射 503，与串行语义一致）", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    await expect(
      mapWithConcurrency(items, async (i) => {
        if (i === 4) throw new Error("fact fetch failed");
        return i;
      }),
    ).rejects.toThrow("fact fetch failed");
  });

  test("空目录零往返", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], async () => { calls += 1; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
