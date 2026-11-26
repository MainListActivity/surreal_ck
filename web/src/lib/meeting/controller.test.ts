import { describe, expect, test } from "bun:test";
import { ATTEMPT_TTL_MS, MeetingController, RELAY_RETRY_MS, type MeetingPhase } from "./controller";
import type { EdgeOptions, EdgeState, MeetingEdgeLike } from "./edge";
import type { MeetingIce } from "./ice";
import { MeetingRpcError, type MeetingRpc, type MeetingSdpRow, type MeetingSnapshot } from "./rpc";
import { encodeWireSdp, sha256Hex } from "./sdp";

const SDP = "v=0\r\nm=audio 9 X 111\r\na=fingerprint:sha-256 AA\r\na=ice-ufrag:u\r\na=ice-pwd:p\r\n";
const OFFER = encodeWireSdp("offer", SDP);
const ANSWER = encodeWireSdp("answer", SDP);
const ME = "5".repeat(64);
const LOW = "1".repeat(64);
const HIGH = "9".repeat(64);

class FakeEdge implements MeetingEdgeLike {
  state: EdgeState = "new";
  chatOpen = false;
  sent: string[] = [];
  closed = false;
  constructor(readonly options: EdgeOptions) {}
  get role() {
    return this.options.role;
  }
  get route() {
    return this.options.route;
  }
  async createOffer() {
    return OFFER;
  }
  async acceptOffer() {
    return ANSWER;
  }
  async acceptAnswer() {
    this.state = "connecting";
  }
  async setTrack() {}
  sendChat(text: string) {
    if (!this.chatOpen) return false;
    this.sent.push(text);
    return true;
  }
  close() {
    this.closed = true;
    this.state = "closed";
  }
  connect() {
    this.state = "connected";
    this.options.events.onState("connected");
  }
}

type Harness = {
  controller: MeetingController;
  rpc: MeetingRpc & { offers: MeetingSdpRow[]; answers: MeetingSdpRow[]; posted: unknown[]; ended: boolean; left: boolean };
  edges: FakeEdge[];
  setMembers(members: string[], status?: "open" | "ended"): void;
  terminated: MeetingPhase[];
  clock: { now: number };
};

function harness(ice: MeetingIce = { direct: [], relay: [{ urls: ["turn:t"], username: "u", credential: "c" }], expiresAtMs: 10 ** 13 }): Harness {
  let members = [ME];
  let status: "open" | "ended" = "open";
  const clock = { now: 1_000_000 };
  const snapshot = (): MeetingSnapshot => ({
    workspace: "ws",
    room: { id: "room", code: "CODE", host: "user:me", status, version: 1, expires_unix: 0 },
    local_join: ME,
    members: members.map((join) => ({ member: join === ME ? "user:me" : `user:${join[0]}`, join_id: join, lease_expires_unix: 0 })),
    server_unix: 0,
  });
  const rpc = {
    offers: [] as MeetingSdpRow[],
    answers: [] as MeetingSdpRow[],
    posted: [] as unknown[],
    ended: false,
    left: false,
    capability: async () => "meeting_v1",
    create: async () => snapshot(),
    invite: async (_room: string, recipients: string[]) => ({ room: "room", invited: recipients }),
    invitations: async () => [],
    join: async () => snapshot(),
    snapshot: async () => snapshot(),
    renew: async () => snapshot(),
    leave: async () => {
      rpc.left = true;
    },
    end: async () => {
      rpc.ended = true;
    },
    postOffer: async (input: unknown) => {
      rpc.posted.push(input);
      return {} as MeetingSdpRow;
    },
    pollOffers: async () => rpc.offers.splice(0),
    postAnswer: async (input: unknown) => {
      rpc.posted.push(input);
      return {} as MeetingSdpRow;
    },
    pollAnswers: async () => rpc.answers.splice(0),
  };
  const edges: FakeEdge[] = [];
  const terminated: MeetingPhase[] = [];
  let seq = 0;
  const controller = new MeetingController({
    rpc,
    fetchIce: async () => ice,
    createEdge: (options) => {
      const edge = new FakeEdge(options);
      edges.push(edge);
      return edge;
    },
    localTrack: () => null,
    randomId: () => (seq++ === 0 ? ME : String(seq).padStart(64, "a")),
    now: () => clock.now,
    onTerminated: (phase) => terminated.push(phase),
    autoTick: false,
  });
  return {
    controller,
    rpc,
    edges,
    terminated,
    clock,
    setMembers(next, nextStatus = "open") {
      members = next;
      status = nextStatus;
    },
  };
}

async function offerRow(from: string, attempt: number, route: "direct" | "relay" = "direct"): Promise<MeetingSdpRow> {
  return {
    workspace: "ws",
    room: "room",
    id: "x",
    sender: "user:1",
    sender_join: from,
    recipient: "user:me",
    recipient_join: ME,
    attempt,
    nonce: "b".repeat(64),
    route,
    offer: OFFER,
    offer_hash: await sha256Hex(OFFER),
    answer: null,
    answer_hash: null,
    expires_unix: 0,
    server_unix: 0,
  };
}

describe("Web 会议状态机（V1 网状房间）", () => {
  test("较小 join_id 发起：首轮 Direct offer，answer 校验 nonce/哈希后接受", async () => {
    const h = harness();
    await h.controller.create();
    h.setMembers([ME, HIGH]);
    await h.controller.tick();
    expect(h.edges).toHaveLength(1);
    expect(h.edges[0]!.role).toBe("offerer");
    const posted = h.rpc.posted[0] as { attempt: number; route: string; nonce: string; offerHash: string; peerJoinId: string };
    expect(posted).toMatchObject({ attempt: 1, route: "direct", peerJoinId: HIGH });
    // 伪造的 answer（nonce 不符）被忽略。
    const row = { ...(await offerRow(ME, 1)), sender_join: ME, recipient_join: HIGH, nonce: posted.nonce, offer_hash: posted.offerHash, answer: ANSWER, answer_hash: await sha256Hex(ANSWER) };
    h.rpc.answers.push({ ...row, nonce: "c".repeat(64) });
    await h.controller.tick();
    expect(h.edges[0]!.state).toBe("new");
    h.rpc.answers.push(row);
    await h.controller.tick();
    expect(h.edges[0]!.state).toBe("connecting");
    h.edges[0]!.connect();
    expect(h.controller.view.peers[0]!.status).toBe("direct");
  });

  test("较大 join_id 只应答，Direct 超时后由发起方改走 Relay", async () => {
    const h = harness();
    await h.controller.join("CODE");
    h.setMembers([LOW, ME]);
    await h.controller.tick();
    expect(h.edges).toHaveLength(0);
    h.rpc.offers.push(await offerRow(LOW, 1));
    await h.controller.tick();
    expect(h.edges[0]!.role).toBe("answerer");
    expect(h.rpc.posted[0]).toMatchObject({ attempt: 1, peerJoinId: LOW });
    // 旧轮次 offer 不会重复应答。
    h.rpc.offers.push(await offerRow(LOW, 1));
    await h.controller.tick();
    expect(h.edges).toHaveLength(1);

    const offerer = harness();
    await offerer.controller.create();
    offerer.setMembers([ME, HIGH]);
    await offerer.controller.tick();
    offerer.clock.now += ATTEMPT_TTL_MS;
    await offerer.controller.tick();
    expect(offerer.edges[0]!.closed).toBe(true);
    offerer.clock.now += RELAY_RETRY_MS;
    await offerer.controller.tick();
    expect(offerer.edges[1]!.route).toBe("relay");
    expect(offerer.edges[1]!.options.iceServers[0]).toMatchObject({ username: "u" });
    expect(offerer.rpc.posted[1]).toMatchObject({ attempt: 2, route: "relay" });
  });

  test("没有托管 TURN 时不接受 Relay offer，也不使用公共 TURN", async () => {
    const h = harness({ direct: [], relay: [], expiresAtMs: 10 ** 13 });
    await h.controller.join("CODE");
    h.setMembers([LOW, ME]);
    h.rpc.offers.push(await offerRow(LOW, 2, "relay"));
    await h.controller.tick();
    expect(h.edges).toHaveLength(0);
  });

  test("成员离开在下一次快照即关闭对应边", async () => {
    const h = harness();
    await h.controller.create();
    h.setMembers([ME, HIGH]);
    await h.controller.tick();
    h.setMembers([ME]);
    await h.controller.tick();
    expect(h.edges[0]!.closed).toBe(true);
    expect(h.controller.view.peers).toHaveLength(0);
  });

  test("主持人结束、被移出或会议失效都立即关闭所有边并释放设备", async () => {
    const ended = harness();
    await ended.controller.create();
    ended.setMembers([ME, HIGH]);
    await ended.controller.tick();
    ended.setMembers([ME, HIGH], "ended");
    await ended.controller.tick();
    expect(ended.controller.view.phase).toBe("ended");
    expect(ended.edges[0]!.closed).toBe(true);
    expect(ended.terminated).toEqual(["ended"]);

    const removed = harness();
    await removed.controller.create();
    removed.setMembers([HIGH]);
    await removed.controller.tick();
    expect(removed.terminated).toEqual(["removed"]);

    const gone = harness();
    await gone.controller.create();
    gone.rpc.snapshot = async () => {
      throw new MeetingRpcError("not_found");
    };
    await gone.controller.tick();
    expect(gone.terminated).toEqual(["removed"]);
  });

  test("主持人散会与普通离会都发送信令且只终止一次", async () => {
    const h = harness();
    await h.controller.create();
    expect(h.controller.view.isHost).toBe(true);
    await h.controller.end();
    expect(h.rpc.ended).toBe(true);
    await h.controller.leave();
    expect(h.rpc.left).toBe(false);
    expect(h.terminated).toEqual(["ended"]);

    const l = harness();
    await l.controller.join("CODE");
    await l.controller.leave();
    expect(l.rpc.left).toBe(true);
    expect(l.terminated).toEqual(["left"]);
  });

  test("聊天只送达已打开 chat-v1 的边，并记录本端消息", async () => {
    const h = harness();
    await h.controller.create();
    h.setMembers([ME, HIGH]);
    await h.controller.tick();
    expect(h.controller.sendChat("你好")).toBe(0);
    h.edges[0]!.chatOpen = true;
    h.edges[0]!.options.events.onChatOpen();
    expect(h.controller.sendChat("  第二条 ")).toBe(1);
    expect(h.edges[0]!.sent).toEqual(["第二条"]);
    h.edges[0]!.options.events.onChat("收到");
    expect(h.controller.view.chat.map((c) => [c.self, c.text])).toEqual([
      [true, "你好"],
      [true, "第二条"],
      [false, "收到"],
    ]);
  });

  test("入会失败进入 failed 并给出中文错误", async () => {
    const h = harness();
    h.rpc.join = async () => {
      throw new MeetingRpcError("not_found");
    };
    await expect(h.controller.join("BAD")).rejects.toThrow();
    expect(h.controller.view.phase).toBe("failed");
    expect(h.controller.view.error).toContain("会议不存在");
  });
});
