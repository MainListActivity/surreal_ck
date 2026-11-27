import type { SurrealConn } from "../surreal";

/**
 * V1 原生会议 RPC（`fn::meeting_*`，见 shared/sql/workspace-template/069-native-meeting.surql）的浏览器适配器。
 * 与原生 `native-identity` 的 `MeetingRpc` 一一对应；浏览器只调用固定函数，不做任意查询。
 */
export type MeetingRoute = "direct" | "relay";

export type MeetingRoom = {
  id: string;
  code: string;
  host: string;
  status: "open" | "ended";
  version: number;
  expires_unix: number;
};

export type MeetingMember = {
  member: string;
  join_id: string;
  lease_expires_unix: number;
};

export type MeetingSnapshot = {
  workspace: string;
  room: MeetingRoom;
  local_join: string | null;
  members: MeetingMember[];
  server_unix: number;
};

export type MeetingInvitation = {
  workspace: string;
  room: string;
  code: string;
  host: string;
  expires_unix: number;
  server_unix: number;
};

export type MeetingInviteResult = { room: string; invited: string[] };

export type MeetingSdpRow = {
  workspace: string;
  room: string;
  id: string;
  sender: string;
  sender_join: string;
  recipient: string;
  recipient_join: string;
  attempt: number;
  nonce: string;
  route: MeetingRoute;
  offer: string;
  offer_hash: string;
  answer: string | null;
  answer_hash: string | null;
  expires_unix: number;
  server_unix: number;
};

export type PostOfferInput = {
  room: string;
  joinId: string;
  peerJoinId: string;
  attempt: number;
  nonce: string;
  route: MeetingRoute;
  offer: string;
  offerHash: string;
};

export type PostAnswerInput = {
  room: string;
  joinId: string;
  peerJoinId: string;
  attempt: number;
  nonce: string;
  wireId?: string;
  route?: MeetingRoute;
  offerHash: string;
  answer: string;
  answerHash: string;
};

export type MeetingRpc = {
  capability(): Promise<string>;
  create(nonce: string): Promise<MeetingSnapshot>;
  invite(room: string, recipients: string[], joinId?: string): Promise<MeetingInviteResult>;
  invitations(): Promise<MeetingInvitation[]>;
  join(code: string, joinId: string): Promise<MeetingSnapshot>;
  snapshot(room: string, joinId: string): Promise<MeetingSnapshot>;
  renew(room: string, joinId: string): Promise<MeetingSnapshot>;
  leave(room: string, joinId: string): Promise<unknown>;
  end(room: string, joinId: string): Promise<unknown>;
  postOffer(input: PostOfferInput): Promise<MeetingSdpRow>;
  pollOffers(room: string, joinId: string): Promise<MeetingSdpRow[]>;
  postAnswer(input: PostAnswerInput): Promise<MeetingSdpRow>;
  pollAnswers(room: string, joinId: string): Promise<MeetingSdpRow[]>;
};

export type MeetingErrorCode =
  | "not_found"
  | "expired"
  | "denied"
  | "conflict"
  | "full"
  | "rate_limited"
  | "unavailable"
  | "unknown";

const ERROR_MESSAGES: Record<MeetingErrorCode, string> = {
  not_found: "会议不存在，或你没有被邀请加入",
  expired: "会议已结束或已过期",
  denied: "会议请求被拒绝",
  conflict: "会议协商冲突，正在重试",
  full: "会议人数已满（当前网状会议最多 4 人）",
  rate_limited: "操作太频繁，请稍后再试",
  unavailable: "当前工作区尚未启用会议能力",
  unknown: "会议服务异常",
};

export class MeetingRpcError extends Error {
  constructor(readonly code: MeetingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MeetingRpcError";
  }
}

export function meetingErrorCode(error: unknown): MeetingErrorCode {
  if (error instanceof MeetingRpcError) return error.code;
  const text = error instanceof Error ? error.message : String(error);
  const match = /meeting:([a-z_]+)/.exec(text);
  const code = match?.[1];
  if (code && code in ERROR_MESSAGES) return code as MeetingErrorCode;
  if (/fn::meeting_\w+.*(not found|does not exist)|NotFound/i.test(text)) return "unavailable";
  return "unknown";
}

export function meetingErrorMessage(error: unknown): string {
  return ERROR_MESSAGES[meetingErrorCode(error)];
}

type QueryConn = Pick<SurrealConn, "query">;

export function createMeetingRpc(conn: QueryConn): MeetingRpc {
  async function call<T>(sql: string, bindings: Record<string, unknown> = {}): Promise<T> {
    try {
      // conn.query 已取首个结果集；单条 RETURN 的结果集就是返回值本身，不能再取 [0]。
      return (await conn.query<T>(sql, bindings)) as unknown as T;
    } catch (error) {
      throw new MeetingRpcError(meetingErrorCode(error));
    }
  }
  return {
    capability: () => call<string>("RETURN fn::meeting_capability()"),
    create: (nonce) => call("RETURN fn::meeting_create($nonce)", { nonce }),
    invite: (room, recipients) =>
      call("RETURN fn::meeting_invite($room, $recipients)", { room, recipients }),
    invitations: () => call("RETURN fn::meeting_invitations()"),
    join: (code, joinId) => call("RETURN fn::meeting_join($code, $join_id)", { code, join_id: joinId }),
    snapshot: (room, joinId) =>
      call("RETURN fn::meeting_snapshot($room, $join_id)", { room, join_id: joinId }),
    renew: (room, joinId) => call("RETURN fn::meeting_renew($room, $join_id)", { room, join_id: joinId }),
    leave: (room, joinId) => call("RETURN fn::meeting_leave($room, $join_id)", { room, join_id: joinId }),
    end: (room, joinId) => call("RETURN fn::meeting_end($room, $join_id)", { room, join_id: joinId }),
    postOffer: (input) =>
      call(
        "RETURN fn::meeting_post_offer($room, $join_id, $peer_join_id, $attempt, $nonce, $route, $offer, $offer_hash)",
        {
          room: input.room,
          join_id: input.joinId,
          peer_join_id: input.peerJoinId,
          attempt: input.attempt,
          nonce: input.nonce,
          route: input.route,
          offer: input.offer,
          offer_hash: input.offerHash,
        },
      ),
    pollOffers: (room, joinId) =>
      call("RETURN fn::meeting_poll_offers($room, $join_id)", { room, join_id: joinId }),
    postAnswer: (input) =>
      call(
        "RETURN fn::meeting_post_answer($room, $join_id, $peer_join_id, $attempt, $nonce, $offer_hash, $answer, $answer_hash)",
        {
          room: input.room,
          join_id: input.joinId,
          peer_join_id: input.peerJoinId,
          attempt: input.attempt,
          nonce: input.nonce,
          offer_hash: input.offerHash,
          answer: input.answer,
          answer_hash: input.answerHash,
        },
      ),
    pollAnswers: (room, joinId) =>
      call("RETURN fn::meeting_poll_answers($room, $join_id)", { room, join_id: joinId }),
  };
}

/** 64 位十六进制随机标识（join_id / nonce），与原生 `random_id` 同长度。 */
export function randomMeetingId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
