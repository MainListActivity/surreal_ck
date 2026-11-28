import type { MeetingEvidenceArchive } from "./evidence-archive";
import type { EvidenceJob, EvidenceJobs } from "./evidence-jobs";
import type { MeetingTrackRecording } from "./evidence-recording";
import { evidenceJson } from "./evidence-vault";
import type { DailyRecording } from "./sfu";

export function dailyRecording(evidence: MeetingEvidenceArchive, recording: MeetingTrackRecording, jobs: EvidenceJobs): DailyRecording {
  return async (workspace, room, actor, time) => {
    await recording.ready();
    const at = new Date(time).toISOString();
    const meeting = `daily:${room}`;
    await evidence.append(workspace, meeting, { id: room, kind: "recording-started", at, payload: { actor, room } });
    return {
      append: (id, kind, timestamp, payload) => evidence.append(workspace, meeting,
        { id, kind, at: new Date(timestamp).toISOString(), payload }),
      async close(time) {
        await jobs.enqueue({ kind: "daily", workspace, meeting, room, actor, at: new Date(time).toISOString() });
      },
      canStop: () => recording.canStop(room),
      stop: () => recording.stop(room),
      resume: () => void jobs.resume().catch(() => console.error("[meeting-evidence] 无法读取封存队列")),
    };
  };
}

export async function finalizeDaily(evidence: MeetingEvidenceArchive, recording: MeetingTrackRecording,
  { workspace, meeting, room, actor, at }: EvidenceJob) {
  if (await evidence.hasRoot(workspace, meeting)) {
    await evidence.publish(workspace, meeting);
    return;
  }
  await evidence.append(workspace, meeting, { id: `${room}:end`, kind: "recording-ended", at, payload: { actor, room } });
  const readEvents = () => evidence.events(workspace, meeting);
  const start = (await readEvents()).find(({ kind }) => kind === "recording-started");
  if (!start) throw new Error("会议缺少录制起始事件");
  const { files, skipped } = await recording.collect(room, meeting, Date.parse(start.at), Date.parse(at), readEvents);
  for (const event of skipped) await evidence.append(workspace, meeting, event);
  const timeline = (await readEvents()).filter(({ kind }) => kind !== "track-unpublished");
  files.set("timeline.json", evidenceJson(timeline));
  await evidence.seal(workspace, meeting, at, { title: "日常会议录制" }, files);
}
