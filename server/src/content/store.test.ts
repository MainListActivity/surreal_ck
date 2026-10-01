import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { SurrealPlatformContentStore } from "./store";

// SurrealDB SDK 把 datetime 字段读回为 DateTime 实例而不是 string；
// fake 必须复刻这个形态，才能覆盖 parseLicense/parsePublished 的序列化路径。
function fakeDb(handlers: Array<[match: string, result: unknown]>) {
  return {
    async query(sql: string): Promise<unknown> {
      for (const [match, result] of handlers) {
        if (sql.includes(match)) return result;
      }
      return [[]];
    },
  };
}

const sourceRow = {
  id: new RecordId("content_source", "src1"),
  source_key: "fixture.example.cn",
  label: "回归夹具",
  status: "active",
  allowed_actions: ["submit", "read"],
};

describe("SurrealPlatformContentStore datetime 读回", () => {
  test("许可 effective_until 以 datetime 读回时序列化为 ISO 字符串而不是 null", async () => {
    const store = new SurrealPlatformContentStore(fakeDb([
      ["FROM content_source", [[sourceRow]]],
      ["FROM source_license_revision", [[{
        id: new RecordId("source_license_revision", "rev1"),
        source: new RecordId("content_source", "src1"),
        revision: 1,
        license_kind: "public",
        allowed_actions: ["submit", "read"],
        effective_from: new DateTime("2026-09-01T00:00:00Z"),
        effective_until: new DateTime("2026-10-31T23:59:59Z"),
        created_by_subject: "operator:local",
        created_at: new DateTime("2026-09-01T00:00:01Z"),
      }]]],
    ]));
    const sources = await store.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.license?.effectiveFrom).toBe("2026-09-01T00:00:00.000Z");
    expect(sources[0]?.license?.effectiveUntil).toBe("2026-10-31T23:59:59.000Z");
    expect(sources[0]?.license?.createdAt).toBe("2026-09-01T00:00:01.000Z");
  });

  test("许可 effective_until 缺省时读回仍为 null", async () => {
    const store = new SurrealPlatformContentStore(fakeDb([
      ["FROM content_source", [[sourceRow]]],
      ["FROM source_license_revision", [[{
        id: new RecordId("source_license_revision", "rev1"),
        source: new RecordId("content_source", "src1"),
        revision: 1,
        license_kind: "public",
        allowed_actions: ["submit"],
        effective_from: new DateTime("2026-09-01T00:00:00Z"),
        created_by_subject: "operator:local",
        created_at: new DateTime("2026-09-01T00:00:01Z"),
      }]]],
    ]));
    const sources = await store.listSources();
    expect(sources[0]?.license?.effectiveUntil).toBeNull();
  });

  test("searchPublished 读回 version 的 published_at/updated_at_source datetime 为 ISO 字符串", async () => {
    const store = new SurrealPlatformContentStore(fakeDb([
      ["FROM content_publication_projection", [[{
        item: {
          public_id: "item-1",
          kind: "legislation",
          publication_status: "published",
          publication_revision: 1,
        },
        version: {
          public_id: "ver-1",
          title: "示例法规",
          body_text: "正文",
          published_at: new DateTime("2026-09-15T08:30:00Z"),
          updated_at_source: new DateTime("2026-09-20T10:00:00Z"),
          source: { source_key: "fixture.example.cn" },
        },
      }]]],
      ["FROM content_citation", [[]]],
    ]));
    const items = await store.searchPublished({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]?.version.publishedAt).toBe("2026-09-15T08:30:00.000Z");
    expect(items[0]?.version.updatedAt).toBe("2026-09-20T10:00:00.000Z");
  });
});
