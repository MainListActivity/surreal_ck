import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";

// Electrobun RPC transport 走 JSON.stringify(BrowserView.ts:193/203)。
// 这套测试钉住一个事实:SurrealDB 的 DateTime / RecordId 自带 toJSON,
// 经 RPC 后 WebView 拿到的就是字符串,我们不需要在主进程出口再写递归序列化器。

describe("RPC 出口序列化:SurrealDB 原生类型", () => {
  test("DateTime 经 JSON.stringify 后是 ISO 字符串", () => {
    const dt = new DateTime("2026-05-04T10:20:30.000Z");
    expect(JSON.stringify(dt)).toBe('"2026-05-04T10:20:30.000Z"');
    expect(JSON.parse(JSON.stringify(dt))).toBe("2026-05-04T10:20:30.000Z");
  });

  test("RecordId 经 JSON.stringify 后是 'tb:id' 字符串", () => {
    const rid = new RecordId("ent_demo", "abc123");
    expect(JSON.stringify(rid)).toBe('"ent_demo:abc123"');
  });

  test("嵌套对象/数组中的 DateTime 与 RecordId 自动递归为字符串", () => {
    const payload = {
      id: new RecordId("ent_demo", "row1"),
      values: {
        title: "合同 A",
        signed_at: new DateTime("2026-05-04T00:00:00.000Z"),
        related: [new RecordId("ent_demo", "row2"), new RecordId("ent_demo", "row3")],
        meta: {
          updated_at: new DateTime("2026-05-04T01:02:03.000Z"),
        },
      },
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      id: "ent_demo:row1",
      values: {
        title: "合同 A",
        signed_at: "2026-05-04T00:00:00.000Z",
        related: ["ent_demo:row2", "ent_demo:row3"],
        meta: { updated_at: "2026-05-04T01:02:03.000Z" },
      },
    });
  });

  test("JS Date 经 JSON.stringify 后也是 ISO 字符串(与 DateTime 形态一致)", () => {
    const d = new Date("2026-05-04T10:20:30.000Z");
    expect(JSON.stringify(d)).toBe('"2026-05-04T10:20:30.000Z"');
  });
});
