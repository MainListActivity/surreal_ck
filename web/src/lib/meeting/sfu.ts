import type {
  MeetingSfuCredentials,
  MeetingSfuParticipant,
  MeetingSfuRoom,
  RosterMeetingFocus,
} from "@surreal-ck/shared";
import type { Track } from "livekit-client";
import { refresh } from "../auth";

export type MeetingSubscription = {
  id: string;
  identity: string;
  source: Track.Source;
  host: boolean;
};

export function selectedMeetingSubscriptions(
  publications: MeetingSubscription[],
  activeSpeakers: string[],
  policy: "desktop" | "mobile" | "audio",
  focus?: RosterMeetingFocus,
): Set<string> {
  const host = publications.find((item) => item.host)?.identity;
  const audio = publications.filter((item) => item.source === "microphone");
  const speaker = activeSpeakers.find((identity) => audio.some((item) => item.identity === identity))
    ?? (audio.some((item) => item.identity === host) ? host : audio[0]?.identity);
  const selected = new Set(audio.filter((item) => policy === "desktop" || item.identity === speaker).map((item) => item.id));
  if (policy !== "audio") {
    if (focus) {
      const share = publications.find((item) => item.host && item.source === "screen_share");
      const camera = publications.find((item) => item.host && item.source === "camera");
      const video = focus === "speaker" ? camera : focus === "screen" ? share : share ?? camera;
      if (video) {
        selected.add(video.id);
        if (video === share) {
          const shareAudio = publications.find((item) => item.identity === share.identity && item.source === "screen_share_audio");
          if (shareAudio) selected.add(shareAudio.id);
        }
      }
      return selected;
    }
    const shares = publications.filter((item) => item.source === "screen_share");
    const share = shares.find((item) => item.host) ?? shares.find((item) => item.identity === speaker) ?? shares[0];
    const camera = policy === "desktop" && publications.find(
      (item) => item.source === "camera" && item.identity === speaker,
    );
    if (share) {
      selected.add(share.id);
      if (policy === "desktop") {
        for (const item of publications) {
          if (item.source === "screen_share_audio" && item.identity === share.identity) selected.add(item.id);
        }
      }
    } else if (camera) selected.add(camera.id);
  }
  return selected;
}

export class SfuRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const token = await refresh();
  if (!token) throw new SfuRequestError(401, "请重新登录后再进入大会");
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/meeting/sfu${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(method !== "GET" && body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new SfuRequestError(response.status, data?.error?.message ?? "私有会议服务暂不可用");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const roomPath = (id: string) => `/rooms/${encodeURIComponent(id)}`;
export const meetingSfuApi = {
  availability: () => request<{ enabled: boolean; maxSeats: number }>("/availability"),
  create: (seats: number) => request<MeetingSfuRoom>("/rooms", "POST", { seats, mode: "daily", large: true }),
  credentials: (id: string) => request<MeetingSfuCredentials>(`${roomPath(id)}/credentials`, "POST"),
  list: (id: string) => request<MeetingSfuParticipant[]>(`${roomPath(id)}/participants`),
  invite: (id: string, subject: string, role: "speaker" | "listener") =>
    request<MeetingSfuParticipant>(`${roomPath(id)}/participants`, "POST", { subject, role }),
  kick: (id: string, identity: string) => request<void>(`${roomPath(id)}/participants/${encodeURIComponent(identity)}`, "DELETE"),
  stopPublishing: (id: string, identity: string) =>
    request<void>(`${roomPath(id)}/participants/${encodeURIComponent(identity)}/stop-publishing`, "POST"),
  end: (id: string) => request<void>(roomPath(id), "DELETE"),
};
