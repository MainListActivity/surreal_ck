import { describe, expect, test } from "bun:test";
import { applyRemoteChange } from "./apply-remote-change";
import type { SyncChange, SyncDb } from "./types";

class FakeDb implements SyncDb {
  queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
  async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> {
    this.queries.push({ sql, bindings });
    return [] as T;
  }
}

describe("应用远端变更到本地", () => {
  test("UPDATE 会写入 remote origin 并 merge 远端字段", async () => {
    const local = new FakeDb();
    const change: SyncChange = {
      table: "workspace",
      versionstamp: "vs1",
      op: "update",
      recordId: "workspace:ws1",
      content: { id: "workspace:ws1", name: "远端名称" },
      dirtyFields: ["name"],
    };

    await applyRemoteChange(local, change);

    expect(local.queries[0]?.sql).toContain("UPDATE $record MERGE $content");
    expect(local.queries[0]?.bindings).toMatchObject({
      record: "workspace:ws1",
      content: {
        name: "远端名称",
        _origin_session_id: "remote:vs1",
      },
    });
  });

  test("本地未推送字段不会被远端 UPDATE 覆盖", async () => {
    const local = new FakeDb();
    const change: SyncChange = {
      table: "workspace",
      versionstamp: "vs2",
      op: "update",
      recordId: "workspace:ws1",
      content: { id: "workspace:ws1", name: "远端名称", slug: "remote-slug" },
      dirtyFields: ["name", "slug"],
    };

    await applyRemoteChange(local, change, {
      pendingLocalFields: async () => new Set(["name"]),
    });

    expect(local.queries[0]?.bindings?.content).toEqual({
      slug: "remote-slug",
      _origin_session_id: "remote:vs2",
    });
  });

  test("DELETE 会删除本地记录", async () => {
    const local = new FakeDb();
    await applyRemoteChange(local, {
      table: "workspace",
      versionstamp: "vs3",
      op: "delete",
      recordId: "workspace:ws1",
      content: {},
    });

    expect(local.queries[0]?.sql).toContain("DELETE $record");
    expect(local.queries[0]?.bindings).toEqual({ record: "workspace:ws1" });
  });
});
