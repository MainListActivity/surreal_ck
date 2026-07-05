import { describe, expect, test } from "bun:test";
import {
  addMember,
  loadMembers,
  removeMember,
  updateMemberRole,
  type MemberEndpointClient,
} from "./members-data";
import type { SurrealConn } from "./surreal";

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

describe("loadMembers — 花名册浏览器直连读 workspace user", () => {
  test("只读 human 且未 disabled 的用户，并把 subject 空值派生成待加入", async () => {
    let capturedSql = "";
    const conn = fakeConn({
      query: async (sql: string) => {
        capturedSql = sql;
        return [
          {
            id: { toString: () => "user:active" },
            display_name: "张三",
            email: "active@example.com",
            is_admin: true,
            subject: "oidc-active",
          },
          {
            id: { toString: () => "user:pending" },
            display_name: null,
            email: "pending@example.com",
            is_admin: false,
            subject: null,
          },
        ] as never;
      },
    });

    const members = await loadMembers(conn);

    expect(capturedSql).toContain("FROM user");
    expect(capturedSql).toContain("kind = 'human'");
    expect(capturedSql).toContain("disabled_at = NONE");
    expect(members).toEqual([
      {
        id: "user:active",
        displayName: "张三",
        email: "active@example.com",
        isAdmin: true,
        pending: false,
      },
      {
        id: "user:pending",
        displayName: null,
        email: "pending@example.com",
        isAdmin: false,
        pending: true,
      },
    ]);
  });
});

function fakeEndpoint(over: Partial<MemberEndpointClient> = {}): MemberEndpointClient {
  return {
    create: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    updateRole: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    remove: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    ...over,
  };
}

describe("addMember — 成员写入走后端 Workspace Scope endpoint", () => {
  test("添加 email + 角色成功时返回 ok:true", async () => {
    let captured:
      | { slug: string; input: { email: string; displayName?: string; isAdmin: boolean } }
      | null = null;
    const endpoint = fakeEndpoint({
      create: async (slug, input) => {
        captured = { slug, input };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    const result = await addMember("acme", {
      email: " new@example.com ",
      displayName: " 新成员 ",
      isAdmin: false,
    }, endpoint);

    expect(result).toEqual({ ok: true });
    expect(captured).toEqual({
      slug: "acme",
      input: { email: "new@example.com", displayName: "新成员", isAdmin: false },
    });
  });

  test("后端拒绝时返回 ok:false 和错误消息", async () => {
    const endpoint = fakeEndpoint({
      create: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: "member-admin-forbidden", message: "Only admins" } }),
      }),
    });

    const result = await addMember("acme", { email: "x@example.com", isAdmin: false }, endpoint);

    expect(result).toEqual({ ok: false, message: "Only admins" });
  });
});

describe("updateMemberRole — 改角色走后端 endpoint", () => {
  test("用 record id 的 id 部分作为 :userId，成功时返回 ok:true", async () => {
    let captured: { slug: string; userId: string; isAdmin: boolean } | null = null;
    const endpoint = fakeEndpoint({
      updateRole: async (slug, userId, isAdmin) => {
        captured = { slug, userId, isAdmin };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    const result = await updateMemberRole("acme", "user:member-id", true, endpoint);

    expect(result).toEqual({ ok: true });
    expect(captured).toEqual({ slug: "acme", userId: "member-id", isAdmin: true });
  });

  test("请求抛错时返回 ok:false 和错误消息", async () => {
    const endpoint = fakeEndpoint({
      updateRole: async () => {
        throw new Error("session expired");
      },
    });

    const result = await updateMemberRole("acme", "user:member-id", false, endpoint);

    expect(result).toEqual({ ok: false, message: "session expired" });
  });
});

describe("removeMember — 移除成员走后端 endpoint", () => {
  test("用 record id 的 id 部分作为 :userId，成功时返回 ok:true", async () => {
    let captured: { slug: string; userId: string } | null = null;
    const endpoint = fakeEndpoint({
      remove: async (slug, userId) => {
        captured = { slug, userId };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    const result = await removeMember("acme", "user:member-id", endpoint);

    expect(result).toEqual({ ok: true });
    expect(captured).toEqual({ slug: "acme", userId: "member-id" });
  });

  test("后端返回错误时返回 ok:false 和错误消息", async () => {
    const endpoint = fakeEndpoint({
      remove: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "member-not-found", message: "Member not found" } }),
      }),
    });

    const result = await removeMember("acme", "user:ghost", endpoint);

    expect(result).toEqual({ ok: false, message: "Member not found" });
  });
});
