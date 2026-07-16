import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { SurrealConn } from "./surreal";
import {
  linkResourceToRecord,
  listResourcesForRecord,
  unlinkResourceFromRecord,
} from "./resource-record-associations";

function fakeConn(results: unknown[][] = []) {
  const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  let cursor = 0;
  const conn = {
    async query(sql: string, bindings?: Record<string, unknown>) {
      calls.push({ sql, bindings });
      return results[cursor++] ?? [];
    },
  } as unknown as SurrealConn;
  return { conn, calls };
}

describe("resource-record associations browser boundary", () => {
  test("关联和解除都用 RecordId 参数，并只操作关系记录", async () => {
    const { conn, calls } = fakeConn([
      [{ id: "resource_record_link:l1" }],
      [{ id: "resource_record_link:l1" }],
    ]);

    await linkResourceToRecord(conn, "resource_item:r1", "ent_claim:c1");
    await unlinkResourceFromRecord(conn, "resource_record_link:l1");

    expect(calls[0]!.sql).toContain("RELATE $resource->resource_record_link->$record");
    expect(calls[0]!.bindings?.resource).toBeInstanceOf(StringRecordId);
    expect(calls[0]!.bindings?.record).toBeInstanceOf(StringRecordId);
    expect(calls[1]!.sql).toContain("DELETE ONLY $link");
    expect(calls[1]!.sql).not.toContain("resource_item");
    expect(calls[1]!.bindings?.link).toBeInstanceOf(StringRecordId);
  });

  test("从当前记录反向遍历关系，返回可展示的全部资源", async () => {
    const { conn, calls } = fakeConn([[
      {
        link_id: "resource_record_link:l1",
        resource_id: "resource_item:r1",
        title: "网页判例",
        summary: "判例摘要",
        source_url: "https://example.test/case",
      },
      {
        link_id: "resource_record_link:l2",
        resource_id: "resource_item:r2",
        title: "人工摘要",
        summary: "人工整理",
      },
    ]]);

    const resources = await listResourcesForRecord(conn, "ent_claim:c1");

    expect(calls[0]!.sql).toContain("FROM $record<-resource_record_link");
    expect(calls[0]!.bindings?.record).toBeInstanceOf(StringRecordId);
    expect(resources).toEqual([
      {
        linkId: "resource_record_link:l1",
        resourceId: "resource_item:r1",
        title: "网页判例",
        summary: "判例摘要",
        sourceUrl: "https://example.test/case",
      },
      {
        linkId: "resource_record_link:l2",
        resourceId: "resource_item:r2",
        title: "人工摘要",
        summary: "人工整理",
      },
    ]);
  });
});
