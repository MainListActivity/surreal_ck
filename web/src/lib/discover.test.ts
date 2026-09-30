import { describe, expect, test } from "bun:test";
import { askDiscover, coverageLabel, kindLabel, sendDiscoverEvent } from "./discover";

/** LCA11 前端契约：访客走公开 query，成员走 evaluate；事件只含结构化字段。 */

describe("discover lib", () => {
  test("标签映射", () => {
    expect(kindLabel("legislation")).toBe("法规");
    expect(kindLabel("judicial_document")).toBe("司法文书");
    expect(kindLabel("unknown_kind")).toBe("unknown_kind");
    expect(coverageLabel("full")).toBe("已覆盖");
    expect(coverageLabel("partial")).toBe("部分覆盖");
    expect(coverageLabel("locked")).toContain("未授权");
    expect(coverageLabel("unavailable")).toBe("暂无覆盖证据");
  });

  test("访客提问打 /api/discover/query，成员打 /api/discover/evaluate", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        scope: { kinds: [], jurisdictions: [], collectionKeys: [], matchedCount: 0, totalListed: 0 },
        matchedItems: [],
        examples: [],
      }));
    }) as typeof fetch;
    try {
      await askDiscover("问题", false);
      await askDiscover("问题", true);
      expect(seen[0]).toContain("/api/discover/query");
      expect(seen[1]).toContain("/api/discover/evaluate");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("事件上报静默失败且不携带原文", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response("bad", { status: 500 });
    }) as typeof fetch;
    try {
      await sendDiscoverEvent({
        kind: "suggestion_dismissed", scopeKinds: ["legislation"], scopeCollections: ["core_statutes"],
        planKey: "lawyer_pro", moduleKey: null, conversion: "dismissed",
      });
      expect(seen[0]).toContain("suggestion_dismissed");
      expect(seen[0]).not.toContain("question");
    } finally {
      globalThis.fetch = original;
    }
  });
});
