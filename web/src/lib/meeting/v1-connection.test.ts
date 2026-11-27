import { describe, expect, mock, test } from "bun:test";
import { createMeetingRpc } from "./rpc";
import { createMeetingV1Connection } from "./v1-connection";

function token(ac: "admin" | "participant", db = "ws_test", sub = "actual-user", version = 1): string {
  const claims = { ac, db, sub, RL: [ac === "admin" ? "Owner" : "Editor"], version };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const admin = token("admin");
const participant = token("participant");

function fixture(initialToken = admin) {
  let source: string | null = initialToken;
  const workspaceQuery = mock(async <T>() => ["workspace connection"] as T[]);
  const memberQuery = mock(async <T>() => ["record connection"] as T[]);
  const close = mock(async () => true as const);
  const exchange = mock(async (_db: string, _source: string) => ({ accessToken: participant, expiresIn: 300 }));
  const connect = mock(async (_db: string, _token: string) => ({ query: memberQuery, close }));
  const connection = createMeetingV1Connection("ws_test", { query: workspaceQuery }, {
    currentToken: () => source,
    exchange,
    connect,
  });
  return {
    connection, rpc: createMeetingRpc(connection), workspaceQuery, memberQuery, close, exchange, connect,
    setToken(next: string | null) { source = next; },
  };
}

describe("V1 会议成员会话", () => {
  test("管理员的创建和主持操作使用独立的本人 RECORD 连接，并复用一次换票", async () => {
    const f = fixture();
    await Promise.all([f.rpc.invitations(), f.rpc.create("nonce")]);
    await f.rpc.end("room", "join");
    expect(f.exchange.mock.calls).toEqual([["ws_test", admin]]);
    expect(f.connect.mock.calls).toEqual([["ws_test", participant]]);
    expect(f.memberQuery).toHaveBeenCalledTimes(3);
    expect(f.workspaceQuery).not.toHaveBeenCalled();
    await f.connection.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    await expect(f.rpc.capability()).rejects.toMatchObject({ code: "denied" });
  });

  test("普通成员使用现有直连，不换票或关闭业务连接", async () => {
    const f = fixture(participant);
    expect(await f.connection.query("RETURN fn::meeting_capability()")).toEqual(["workspace connection"]);
    await f.connection.close();
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  test.each([admin, token("participant", "ws_other"), token("participant", "ws_test", "other-user")])(
    "换票身份不匹配时拒绝，不连接或退回管理员业务会话",
    async (wrongToken) => {
      const f = fixture();
      f.exchange.mockResolvedValueOnce({ accessToken: wrongToken, expiresIn: 300 });
      await expect(f.rpc.create("nonce")).rejects.toMatchObject({ code: "denied" });
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.workspaceQuery).not.toHaveBeenCalled();
    },
  );

  test("拒绝在换票期间已被切换的工作区，不使用迟到的票据", async () => {
    const f = fixture();
    const attempted = f.rpc.create("nonce");
    f.setToken(token("admin", "ws_other"));
    await expect(attempted).rejects.toMatchObject({ code: "denied" });
    await expect(f.rpc.capability()).rejects.toMatchObject({ code: "denied" });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.workspaceQuery).not.toHaveBeenCalled();
  });

  test("换票短暂失败可重试，管理员票据刷新时回收旧连接", async () => {
    const f = fixture();
    f.exchange.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.rpc.capability()).rejects.toMatchObject({ code: "unknown" });
    await f.rpc.capability();
    const refreshed = token("admin", "ws_test", "actual-user", 2);
    f.setToken(refreshed);
    await f.rpc.capability();
    expect(f.exchange.mock.calls).toEqual([["ws_test", admin], ["ws_test", admin], ["ws_test", refreshed]]);
    expect(f.close).toHaveBeenCalledTimes(1);
    await f.connection.close();
    expect(f.close).toHaveBeenCalledTimes(2);
  });
});
