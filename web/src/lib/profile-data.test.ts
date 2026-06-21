import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import { loadCurrentUser, saveDisplayName } from "./profile-data";
import type { SurrealConn } from "./surreal";

/** 仅实现 profile-data 用到的 SurrealConn 窄接口。 */
function fakeConn(over: Partial<SurrealConn> = {}): SurrealConn {
  return {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: async () => [],
    queryRaw: async () => [],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run({} as never),
    ...over,
  } as unknown as SurrealConn;
}

describe("loadCurrentUser — 直连 fn::current_user() 读当前用户", () => {
  test("SELECT user WHERE id = fn::current_user()，规整 record id 为字符串", async () => {
    let captured = "";
    const conn = fakeConn({
      query: async (sql: string) => {
        captured = sql;
        return [
          {
            id: { toString: () => "user:abc" },
            email: "a@example.com",
            display_name: "张三",
            is_admin: true,
          },
        ] as never;
      },
    });

    const profile = await loadCurrentUser(conn);

    expect(captured).toContain("fn::current_user()");
    expect(captured).toContain("FROM user");
    expect(profile).toEqual({
      id: "user:abc",
      email: "a@example.com",
      displayName: "张三",
      isAdmin: true,
    });
  });

  test("display_name 缺省 → null；is_admin 缺省 → false", async () => {
    const conn = fakeConn({
      query: async () => [{ id: { toString: () => "user:x" }, email: "x@example.com" }] as never,
    });

    const profile = await loadCurrentUser(conn);

    expect(profile?.displayName).toBeNull();
    expect(profile?.isAdmin).toBe(false);
  });

  test("fn::current_user() 解析不到（空结果）→ null", async () => {
    const conn = fakeConn({ query: async () => [] });
    expect(await loadCurrentUser(conn)).toBeNull();
  });
});

describe("saveDisplayName — UPDATE record id，空名写 NONE", () => {
  test("明确 UPDATE $id，id 包成 StringRecordId，trim 后非空", async () => {
    let capturedSql = "";
    let capturedBindings: Record<string, unknown> = {};
    const conn = fakeConn({
      query: async (sql: string, bindings?: Record<string, unknown>) => {
        capturedSql = sql;
        capturedBindings = bindings ?? {};
        return [] as never;
      },
    });

    const result = await saveDisplayName(conn, "user:abc", "  李四  ");

    expect(capturedSql).toBe("UPDATE $id SET display_name = $name");
    expect(capturedBindings.id).toBeInstanceOf(StringRecordId);
    expect((capturedBindings.id as StringRecordId).toString()).toBe("user:abc");
    expect(capturedBindings.name).toBe("李四");
    expect(result).toEqual({ ok: true, displayName: "李四" });
  });

  test("空名（trim 后为空）→ 写 undefined(NONE) 而非 null，displayName 回 null", async () => {
    let capturedName: unknown = "untouched";
    const conn = fakeConn({
      query: async (_sql: string, bindings?: Record<string, unknown>) => {
        capturedName = (bindings ?? {}).name;
        return [] as never;
      },
    });

    const result = await saveDisplayName(conn, "user:abc", "   ");

    expect(capturedName).toBeUndefined();
    expect(result).toEqual({ ok: true, displayName: null });
  });

  test("写入抛错 → 返回 ok:false 带可读信息", async () => {
    const conn = fakeConn({
      query: async () => {
        throw new Error("权限不足");
      },
    });

    const result = await saveDisplayName(conn, "user:abc", "王五");

    expect(result).toEqual({ ok: false, message: "权限不足" });
  });
});
