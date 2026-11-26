export const LEGACY_MEETING_MESH_LIMIT = 4;
export const PRIVATE_MEETING_MAX_SEATS = 30;
export const MEETING_SFU_SIGNAL_PATH = "/api/meeting/sfu/signal";

export type MeetingSfuRole = "host" | "speaker" | "listener";
export type MeetingMode = "daily" | "controlled";

export function selectMeetingTopology(mode: MeetingMode, seats: number, large = false): "mesh" | "sfu" {
  return mode === "controlled" || large || seats > LEGACY_MEETING_MESH_LIMIT ? "sfu" : "mesh";
}

export type MeetingSfuRoom = {
  id: string;
  seats: number;
  expiresAt: number;
  topology: "sfu";
};

export type MeetingSfuCredentials = {
  url: string;
  token: string;
  role: MeetingSfuRole;
  leaseExpiresAt: number;
};

export type MeetingSfuParticipant = {
  id: string;
  memberSubject: string;
  name: string;
  role: MeetingSfuRole;
  revoked: boolean;
};
