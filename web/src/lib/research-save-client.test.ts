import { describe, expect, test } from "bun:test";
import type { ResearchSaveEvent } from "@surreal-ck/shared";
import { createResearchSaveClient } from "./research-save-client";

function sseResponse(blocks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

const request = {
  sessionId: "research_session:s1",
  draft: {
    title: "标题",
    summary: "摘要",
    evidence: [{ text: "证据", capturedAt: "2026-06-11T08:00:00.000Z", order: 0 }],
  },
};

describe("createResearchSaveClient", () => {
  test("POST 带 Bearer token，把 SSE data 行解析成事件回调（跨 chunk 缓冲）", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = createResearchSaveClient({
      getToken: () => "token-1",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init! };
        return sseResponse([
          'event: validating\ndata: {"kind":"validating"}\n\n',
          // 故意把一个事件拆到两个 chunk，验证缓冲
          'event: embedding\ndata: {"kind":"embe',
          'dding","status":"disabled"}\n\nevent: done\ndata: {"kind":"done","resourceId":"resource_item:r1","embeddingStatus":"disabled"}\n\n',
        ]);
      },
    });

    const events: ResearchSaveEvent[] = [];
    await client.save(request, (event) => events.push(event));

    expect(captured!.url).toBe("/api/resources/research/save");
    expect(new Headers(captured!.init.headers).get("authorization")).toBe("Bearer token-1");
    expect(JSON.parse(String(captured!.init.body)).sessionId).toBe("research_session:s1");
    expect(events.map((event) => event.kind)).toEqual(["validating", "embedding", "done"]);
  });

  test("非 2xx 响应 → 抛错，不产出事件", async () => {
    const client = createResearchSaveClient({
      getToken: () => "token-1",
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });

    const events: ResearchSaveEvent[] = [];
    await expect(client.save(request, (event) => events.push(event))).rejects.toThrow("403");
    expect(events).toHaveLength(0);
  });

  test("不合法的 data 块被跳过，不打断后续事件", async () => {
    const client = createResearchSaveClient({
      getToken: () => null,
      fetchImpl: async () =>
        sseResponse([
          "data: not-json\n\n",
          'data: {"kind":"unknown-kind"}\n\n',
          'event: done\ndata: {"kind":"done","resourceId":"resource_item:r1","embeddingStatus":"disabled"}\n\n',
        ]),
    });

    const events: ResearchSaveEvent[] = [];
    await client.save(request, (event) => events.push(event));
    expect(events.map((event) => event.kind)).toEqual(["done"]);
  });
});
