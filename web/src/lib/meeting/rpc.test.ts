import { describe, expect, test } from "bun:test";
import { createMeetingRpc, meetingErrorCode, MeetingRpcError, randomMeetingId } from "./rpc";

describe("会议 RPC 适配器", () => {
  test("只调用固定 fn::meeting_* 并参数化绑定", async () => {
    const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const rpc = createMeetingRpc({
      async query<T>(sql: string, bindings?: Record<string, unknown>) {
        calls.push({ sql, bindings });
        return { local_join: "a".repeat(64) } as unknown as T[];
      },
    });
    expect(await rpc.join("ABCDEF", "a".repeat(64))).toEqual({ local_join: "a".repeat(64) });
    await rpc.postOffer({
      room: "r",
      joinId: "j",
      peerJoinId: "p",
      attempt: 1,
      nonce: "n",
      route: "direct",
      offer: "{}",
      offerHash: "h",
    });
    expect(calls[0]).toEqual({ sql: "RETURN fn::meeting_join($code, $join_id)", bindings: { code: "ABCDEF", join_id: "a".repeat(64) } });
    expect(calls[1]!.sql).toContain("fn::meeting_post_offer(");
    expect(calls[1]!.bindings).toMatchObject({ peer_join_id: "p", route: "direct", offer_hash: "h" });
    for (const call of calls) expect(call.sql).toMatch(/^RETURN fn::meeting_\w+\(/);
  });

  test("单条 RETURN 的标量结果原样返回", async () => {
    const rpc = createMeetingRpc({
      async query<T>() {
        return "meeting_v1" as unknown as T[];
      },
    });
    expect(await rpc.capability()).toBe("meeting_v1");
  });

  test("服务端固定错误码映射为中文可读错误", async () => {
    const rpc = createMeetingRpc({
      async query() {
        throw new Error("An error occurred: meeting:full");
      },
    });
    const error = await rpc.join("X", "y").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingRpcError);
    expect((error as MeetingRpcError).code).toBe("full");
    expect(meetingErrorCode(new Error("The function 'fn::meeting_capability' does not exist"))).toBe("unavailable");
    expect(meetingErrorCode(new Error("boom"))).toBe("unknown");
  });

  test("随机标识为 64 位小写十六进制", () => {
    expect(randomMeetingId()).toMatch(/^[0-9a-f]{64}$/);
  });
});
