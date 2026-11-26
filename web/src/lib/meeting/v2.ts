import { getToken } from "../auth";
import { NO_MEETING_ICE, splitIceServers } from "./ice";
import { MeetingRpcError, type MeetingErrorCode, type MeetingRpc, type MeetingSnapshot } from "./rpc";
import type { MeetingIceServersResponse } from "@surreal-ck/shared/meeting-ice";

type Command = Record<string, unknown>;
const endpoint = "/api/meeting/v2/";
export const isV2MeetingCode = (code: string): boolean => /^V2[0-9A-F]{64}$/u.test(code);

export async function meetingV2Request<T>(kind: "member" | "guest", command: Command, signal?: AbortSignal): Promise<T> {
  const token = kind === "member" ? getToken() : null;
  const response = await fetch(`${endpoint}${kind}`, {
    method: "POST", cache: "no-store", credentials: kind === "guest" ? "same-origin" : "omit",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(command), signal,
  });
  if (!response.ok) {
    const data: { error?: { code?: string } } | null = await response.json().catch(() => null);
    const code = data?.error?.code;
    const mapped: MeetingErrorCode = code === "meeting-expired" ? "expired"
      : response.status === 401 ? "not_found"
      : code === "meeting-full" ? "full"
      : response.status === 409 ? "conflict"
      : response.status === 429 ? "rate_limited"
      : response.status === 403 ? "denied"
      : response.status === 503 ? "unavailable" : "unknown";
    throw new MeetingRpcError(mapped);
  }
  return (await response.json()) as T;
}

export function createMeetingV2Rpc(kind: "member" | "guest", connection?: string): MeetingRpc {
  const send = <T>(op: string, data: Command = {}) => meetingV2Request<T>(kind, { ...data, op, connection }, AbortSignal.timeout(2200));
  const bound = <T>(op: string, room: string, join_id: string) => send<T>(op, { room, join_id });
  return {
    capability: async () => (await send<{ version: string }>("capability")).version,
    create: (nonce) => send("create", { nonce }),
    join: (code, join_id) => send("join", { code, join_id }),
    invite: (room, recipients, join_id) => send("invite_members", { room, recipients, join_id }),
    invitations: async () => [],
    snapshot: (room, join) => bound("snapshot", room, join),
    renew: (room, join) => bound("renew", room, join),
    leave: (room, join) => bound("leave", room, join),
    end: (room, join) => bound("end", room, join),
    postOffer: (p) => send("post_offer", {
      room: p.room, join_id: p.joinId, peer_join_id: p.peerJoinId, attempt: p.attempt, nonce: p.nonce,
      route: p.route, offer: p.offer, offer_hash: p.offerHash,
    }),
    pollOffers: (room, join) => bound("poll_offers", room, join),
    postAnswer: (p) => send("post_answer", {
      room: p.room, join_id: p.joinId, peer_join_id: p.peerJoinId, attempt: p.attempt, nonce: p.nonce,
      id: p.wireId, route: p.route, offer_hash: p.offerHash, answer: p.answer, answer_hash: p.answerHash,
    }),
    pollAnswers: (room, join) => bound("poll_answers", room, join),
  };
}

export async function connectGuest() {
  return meetingV2Request<{ connection: string; snapshot: MeetingSnapshot }>("guest", { op: "connect" });
}

export async function fetchGuestIce(connection: string) {
  try {
    return splitIceServers(await meetingV2Request<MeetingIceServersResponse>("guest", { op: "ice", connection }, AbortSignal.timeout(2200)));
  } catch (error) {
    if (error instanceof MeetingRpcError && error.code === "unavailable") return NO_MEETING_ICE;
    throw error;
  }
}
