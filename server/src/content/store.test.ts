import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { createSyntheticJudgmentBatch, createSyntheticLegislationBatch } from "@surreal-ck/shared/platform-content";
import { SurrealPlatformContentStore } from "./store";
import type { StoredContentBatch } from "./service";

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
  test("批次条目和发布的条文/引文数量不改变事务 SQL，空数组也使用同一模板", async () => {
    for (const factory of [createSyntheticLegislationBatch, createSyntheticJudgmentBatch]) {
      const base = await factory();
      const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
      const db = {
        async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
          queries.push({ sql, params });
          if (sql.includes("FROM content_source WHERE")) return [[sourceRow]];
          if (sql.includes("SELECT VALUE id FROM ingestion_batch")) return [[new RecordId("ingestion_batch", "one")]];
          if (sql.includes("SELECT VALUE id FROM ingestion_entry")) return [[new RecordId("ingestion_entry", "one")]];
          return [[]];
        },
      };
      const store = new SurrealPlatformContentStore(db);
      const saved: string[] = [], published: string[] = [];
      for (const count of [0, 1, 100]) {
        const request = structuredClone(base);
        const first = request.items[0]!;
        if (first.operation !== "upsert") throw new Error("fixture is not upsert");
        if (first.payload.kind === "legislation") {
          const article = first.payload.legislation.articles[0]!;
          first.payload.legislation.articles = Array.from({ length: count }, (_, i) => ({ ...article, localKey: `a${i}` }));
        } else {
          const citation = first.payload.judgment.citations[0]!;
          first.payload.judgment.citations = Array.from({ length: count }, (_, i) => ({ ...citation, localCitationKey: `c${i}` }));
        }
        request.items = Array.from({ length: count || 1 }, (_, i) => ({ ...first, entryKey: `entry-${i}` }));
        const batch: StoredContentBatch = {
          batchId: "batch-one", actorSubject: "operator:local", idempotencyKey: "one", requestDigest: "digest", request,
          receivedAt: "2026-09-01T00:00:00Z", status: "accepted", validationRevision: 1,
          entries: request.items.slice(0, count).map((item) => ({ entryKey: item.entryKey, operation: item.operation, status: "accepted", issues: [] })),
        };
        await store.saveBatch(batch);
        const save = queries.at(-1)!;
        saved.push(save.sql);
        expect(save.params?.entries).toHaveLength(count);
        expect(String(save.params?.batch)).toBe(String(new RecordId("ingestion_batch", batch.batchId)));
        expect((await store.applyPublication({ batch, entryKey: "entry-0", actorSubject: batch.actorSubject, publicationId: "publication-one" })).status).toBe("published");
        const publish = queries.filter((query) => query.sql.startsWith("BEGIN TRANSACTION;")).at(-1)!;
        published.push(publish.sql);
        expect(String(publish.params?.publicationRequest)).toBe(String(new RecordId("publication_request", "publication-one")));
        const values = (publish.params?.articles ?? publish.params?.citations) as Array<Record<string, unknown>>;
        expect(values).toHaveLength(count);
        if (values.length) {
          expect(values[0]!.id).toBeInstanceOf(StringRecordId);
          if (first.payload.kind === "judicial_document") expect(values[0]!.resolution_id).toBeInstanceOf(StringRecordId);
        }
      }
      expect(new Set(saved).size).toBe(1);
      expect(new Set(published).size).toBe(1);
    }
  });

  test("批次事务写失败后仍尝试取消，错误不转成成功", async () => {
    const calls: string[] = [];
    const request = await createSyntheticJudgmentBatch();
    const store = new SurrealPlatformContentStore({ async query(sql) {
      calls.push(sql);
      if (sql.startsWith("BEGIN TRANSACTION;")) throw new Error("fixture-write-error");
      return [];
    } });
    await expect(store.saveBatch({ batchId: "failed", actorSubject: "operator:local", idempotencyKey: "failed",
      requestDigest: "digest", request, receivedAt: "2026-09-01T00:00:00Z", status: "accepted", validationRevision: 1, entries: [],
    })).rejects.toThrow("fixture-write-error");
    expect(calls.at(-1)).toBe("CANCEL TRANSACTION;");
  });

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
