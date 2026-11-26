import type { MeetingIceServersResponse } from "@surreal-ck/shared/meeting-ice";
import { api } from "../api";

/** M-04 托管 TURN：按会话短期签发，前端不持有任何静态凭据。 */
export type MeetingIce = {
  /** Direct 路由可用的 STUN（无凭据条目）。 */
  direct: RTCIceServer[];
  /** Relay 路由可用的 TURN（带短期凭据条目）。 */
  relay: RTCIceServer[];
  expiresAtMs: number;
};

export const NO_MEETING_ICE: MeetingIce = { direct: [], relay: [], expiresAtMs: Number.POSITIVE_INFINITY };

export function splitIceServers(response: MeetingIceServersResponse): MeetingIce {
  const direct: RTCIceServer[] = [];
  const relay: RTCIceServer[] = [];
  for (const server of response.iceServers) {
    if (server.username !== undefined && server.credential !== undefined) {
      relay.push({ urls: server.urls, username: server.username, credential: server.credential });
    } else {
      direct.push({ urls: server.urls.filter((url) => url.startsWith("stun:") || url.startsWith("stuns:")) });
    }
  }
  const expiresAtMs = Date.parse(response.expiresAt);
  return {
    direct: direct.filter((s) => (s.urls as string[]).length > 0),
    relay,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + response.ttlSeconds * 1000,
  };
}

/** 503（未配置 TURN）时只走直连，不回退到公共 TURN。 */
export async function fetchMeetingIce(): Promise<MeetingIce> {
  const res = await api.api.meeting["ice-servers"].$post();
  if (!res.ok) return NO_MEETING_ICE;
  return splitIceServers((await res.json()) as MeetingIceServersResponse);
}
