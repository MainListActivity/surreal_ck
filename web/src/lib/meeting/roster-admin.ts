import type { MeetingSfuRoom, RosterMeetingCommand, RosterMeetingModeration } from "@surreal-ck/shared";
import { refresh } from "../auth";
import { RosterRequestError, rosterRequest } from "./roster";
import type { RosterArchiveConfig, RosterArchiveSheets } from "./roster-archive";
import type { RosterPollInput, RosterPollResult } from "./roster-polls";

export type RosterMeetingInput = {
  title: string; scheduled_at: string; sheet_id: string; preset_key?: string;
  display_field?: string; check_field?: string; check_label?: string; check_mode?: "full" | "suffix4";
  admission?: "direct" | "waiting"; concurrency?: "replace" | "reject";
};
export type RosterMeeting = Omit<RosterMeetingInput, "admission" | "concurrency"> & {
  id: string; status: "open" | "closed"; room_id?: string; admission: "direct" | "waiting"; concurrency: "replace" | "reject";
};
export type RosterPass = {
  id: string; row_id: string; status: "active" | "revoked"; opened_at?: string;
  lease_state?: "waiting" | "admitted" | "kicked"; generation: number;
};
export type RosterWaiting = { id: string; name: string; generation: number };
export type EvidenceStatus = { root: string; sealedAt: string; retainUntil: string; backupReminder: boolean };

export function createRosterAdminApi(slug: string, getToken: () => Promise<string | null> = refresh, fetcher?: typeof fetch) {
  const base = `/api/workspaces/${encodeURIComponent(slug)}/roster-meetings`;
  const meetingPath = (id: string) => `/${encodeURIComponent(id)}`;
  const passPath = (meeting: string, id: string) => `${meetingPath(meeting)}/passes/${encodeURIComponent(id)}`;
  async function request(path: string, method?: "POST" | "PUT" | "DELETE", body?: unknown) {
    const token = await getToken();
    if (!token) throw new RosterRequestError(401, "请重新登录后再管理名册会议");
    return rosterRequest(base + path, { token, method, body, fetcher });
  }
  async function json<T>(path: string, method?: "POST", body?: unknown) {
    return (await request(path, method, body)).json() as Promise<T>;
  }
  return {
    list: async () => (await json<{ meetings: RosterMeeting[] }>("")).meetings,
    create: (input: RosterMeetingInput) => json<RosterMeeting>("", "POST", input),
    passes: async (id: string) => (await json<{ passes: RosterPass[] }>(`${meetingPath(id)}/passes`)).passes,
    issue: async (id: string, row_ids: string[]) => (await request(`${meetingPath(id)}/passes`, "POST", { row_ids })).blob(),
    reissue: async (id: string, row_id: string) => (await request(`${meetingPath(id)}/passes/reissue`, "POST", { row_id })).blob(),
    revoke: (id: string, pass: string) => request(passPath(id, pass), "DELETE"),
    start: (id: string) => json<MeetingSfuRoom>(`${meetingPath(id)}/start`, "POST"),
    end: (id: string) => request(`${meetingPath(id)}/end`, "POST"),
    polls: async (id: string) => (await json<{ polls: RosterPollResult[] }>(`${meetingPath(id)}/polls`)).polls,
    createPoll: (id: string, input: RosterPollInput) => request(`${meetingPath(id)}/polls`, "POST", input),
    archiveConfig: (id: string) => json<RosterArchiveConfig>(`${meetingPath(id)}/archive-config`),
    saveArchiveConfig: (id: string, input: RosterArchiveSheets & { weightField?: string }) =>
      request(`${meetingPath(id)}/archive-config`, "PUT", input),
    archive: (id: string) => json<RosterArchiveSheets>(`${meetingPath(id)}/archive`, "POST"),
    evidenceStatus: (id: string) => json<EvidenceStatus>(`${meetingPath(id)}/evidence/status`),
    finalizeEvidence: (id: string) => request(`${meetingPath(id)}/evidence/finalize`, "POST"),
    downloadEvidence: async (id: string) => {
      const path = `${meetingPath(id)}/evidence`;
      const { url } = await json<{ url: string }>(`${path}/grant`, "POST");
      if (!url.startsWith(`${base}${path}/download?`)) throw new Error("会议存证下载链接无效");
      return (await request(url.slice(base.length))).blob();
    },
    moderation: (id: string) => json<RosterMeetingModeration>(`${meetingPath(id)}/moderation`),
    moderate: (id: string, command: RosterMeetingCommand) =>
      json<RosterMeetingModeration>(`${meetingPath(id)}/moderation`, "POST", command),
    waiting: async (id: string) => (await json<{ waiting: RosterWaiting[] }>(`${meetingPath(id)}/waiting`)).waiting,
    decide: (id: string, pass: string, generation: number, action: "admit" | "reject" | "kick") =>
      request(`${passPath(id, pass)}/${action}`, "POST", { generation }),
  };
}
