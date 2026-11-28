import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DirectFileOutput, EgressClient, EgressStatus, TwirpError, type EgressInfo } from "livekit-server-sdk";
import { env } from "../env";
import type { EvidenceArtifact, EvidenceEvent } from "./evidence-ledger";

const trackPattern = /^TR_[\da-z]+$/iu;
const roomPattern = /^ck-meeting-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const active = (status: EgressStatus) => status < EgressStatus.EGRESS_COMPLETE;
const incomplete = () => new Error("轨道录制未完整结束，不可封存");
const trackNotFound = (message: string, track: string) => message === "track not found" || message === `track ${track} not found`;
// LiveKit 生命周期 webhook 的时间戳精度为秒。
const shortPublicationMs = 2_000;

export type TrackStartOutcome = "track-not-found" | void;

export class MeetingTrackRecording {
  private readonly requests = new Map<string, Promise<TrackStartOutcome>>();
  private readonly requested = new Set<string>();
  private readonly failedStarts = new Set<string>();
  private synthesis = Promise.resolve();

  constructor(private readonly directory: string, private readonly egress: EgressClient) {}

  async ready() {
    const path = resolve(this.directory);
    const info = await stat(path);
    if (path !== await realpath(path) || !info.isDirectory() || (info.mode & 0o2007) !== 0o2000) {
      throw new Error("轨道录制暂存目录须为私有共享组目录");
    }
    await this.egress.listEgress({ active: true });
  }

  start(room: string, track: string, audio: boolean, at: number): Promise<TrackStartOutcome> {
    if (!roomPattern.test(room) || !trackPattern.test(track)) throw new Error("会议室或轨道标识无效");
    const key = `${room}/${track}`;
    if (!this.requests.has(key)) {
      this.requested.add(key);
      const request = (async (): Promise<TrackStartOutcome> => {
        const folder = join(this.directory, room);
        await mkdir(folder, { recursive: true, mode: 0o2770 });
        await chmod(folder, 0o2770);
        try {
          await this.egress.startTrackEgress(room,
            new DirectFileOutput({ filepath: join(folder, `${track}-${at}${audio ? "-audio" : "-video"}`) }), track);
        } catch (error) {
          if (error instanceof TwirpError && error.status === 404 && error.code === "not_found"
            && trackNotFound(error.message, track)) return "track-not-found";
          throw error;
        }
      })();
      this.requests.set(key, request);
      void request.catch(() => {
        // 即使写入独立账本失败，当前进程也保留这次起录故障。
        this.failedStarts.add(key);
        this.requests.delete(key);
      });
    }
    return this.requests.get(key)!;
  }

  collect(id: string, meeting: string, start: number, end: number, readEvents: () => Promise<readonly EvidenceEvent[]> = async () => []) {
    const operation = this.synthesis.then(() => this.synthesize(`ck-meeting-${id}`, meeting, start, end, readEvents));
    this.synthesis = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async stop(id: string) {
    await this.stopTracks(`ck-meeting-${id}`);
  }

  async canStop(id: string) {
    return !(await this.tracks(`ck-meeting-${id}`)).some(({ status }) => status === EgressStatus.EGRESS_STARTING);
  }

  private async tracks(room: string) {
    if (!roomPattern.test(room)) throw new Error("会议室标识无效");
    await Promise.all([...this.requests].filter(([key]) => key.startsWith(room + "/")).map(([, request]) => request));
    return this.egress.listEgress({ roomName: room });
  }

  private async stopTracks(room: string) {
    // 起录中的任务须先报告真实的订阅结果，主动中止会丢掉结果。
    const stopping = (status: EgressStatus) => status === EgressStatus.EGRESS_ACTIVE;
    const tracks = await this.tracks(room);
    await Promise.all(tracks.filter(({ status }) => stopping(status))
      .map(({ egressId }) => this.egress.stopEgress(egressId).catch(async (error) => {
        if ((await this.egress.listEgress({ egressId })).some(({ status }) => stopping(status))) throw error;
      })));
    return tracks;
  }

  private reconcileTracks(room: string, tracks: readonly EgressInfo[], requested: readonly string[], events: readonly EvidenceEvent[]) {
    const published = new Map<string, string>();
    const unpublished = new Map<string, string>();
    const notFound = new Set<string>();
    const startFailed = new Set<string>();
    for (const { id, kind, at } of events) {
      if (kind === "track-published") published.set(id.slice(0, -":published".length), at);
      if (kind === "track-unpublished") unpublished.set(id.slice(0, -":unpublished".length), at);
      if (kind === "track-egress-not-found") notFound.add(id.slice(0, -":egress-not-found".length));
      if (kind === "track-egress-start-failed") startFailed.add(id.slice(0, -":egress-start-failed".length));
    }
    const endedBeforeRecording = (track: string) => {
      const publishedAt = published.get(track);
      const endedAt = unpublished.get(track);
      if (!publishedAt || !endedAt || startFailed.has(track) || this.failedStarts.has(`${room}/${track}`)) return;
      const duration = Date.parse(endedAt) - Math.floor(Date.parse(publishedAt) / 1000) * 1000;
      if (duration >= 0 && duration <= shortPublicationMs) return { publishedAt, endedAt };
    };
    const completed: EgressInfo[] = [];
    const completedIds = new Set<string>();
    for (const item of tracks) {
      const track = item.request?.case === "track" ? item.request.value.trackId : "";
      if (!trackPattern.test(track)) throw incomplete();
      if (item.status === EgressStatus.EGRESS_COMPLETE) {
        completed.push(item);
        completedIds.add(track);
      } else {
        // EgressInfo.startedAt 是任务创建时间。文件结果表示是否实际收到媒体。
        if (item.status !== EgressStatus.EGRESS_FAILED || item.retryCount !== 0 || item.errorCode !== 404 || !trackNotFound(item.error, track)
          || item.fileResults.some(({ startedAt, duration, size }) => startedAt !== 0n || duration !== 0n || size !== 0n)
          || !endedBeforeRecording(track)) throw incomplete();
        notFound.add(track);
      }
    }
    const skipped: EvidenceEvent[] = [];
    for (const track of new Set([...published.keys(), ...requested])) {
      if (completedIds.has(track)) continue;
      const ended = endedBeforeRecording(track);
      if (!ended || !notFound.has(track)) throw incomplete();
      skipped.push({
        id: `${track}:recording-skipped`, kind: "track-recording-skipped", at: ended.endedAt,
        payload: { track, publishedAt: ended.publishedAt, reason: "ended-before-recording" },
      });
    }
    return { completed, skipped };
  }

  private async synthesize(room: string, meeting: string, start: number, end: number, readEvents: () => Promise<readonly EvidenceEvent[]>) {
    let tracks = await this.stopTracks(room);
    for (let retry = 0; retry < 30 && tracks.some(({ status }) => active(status)); retry++) {
      await Bun.sleep(1000);
      tracks = await this.stopTracks(room);
    }
    const requested = [...this.requested].filter((key) => key.startsWith(room + "/"));
    const { completed, skipped } = this.reconcileTracks(room, tracks, requested.map((key) => key.slice(room.length + 1)), await readEvents());
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("录制起止时间无效");
    const folder = join(this.directory, room);
    await mkdir(folder, { recursive: true, mode: 0o2770 });
    const artifacts = new Map<string, EvidenceArtifact>();
    const store = async (path: string, name: string) => {
      const file = Bun.file(path);
      if ((await stat(path)).size === 0) throw new Error("会议录制轨道为空");
      artifacts.set(name, file);
    };
    const input: string[] = [];
    const filters: string[] = [];
    const audio: string[] = [];
    const indexEntries: { track: string; file: string; startUtc: string }[] = [];
    let video = "[0:v]";
    const duration = (end - start) / 1000;
    for (const item of completed.sort((a, b) => a.startedAt === b.startedAt
      ? a.egressId.localeCompare(b.egressId) : a.startedAt < b.startedAt ? -1 : 1)) {
      if (item.request?.case !== "track" || !trackPattern.test(item.request.value.trackId)) throw new Error("录制轨道无效");
      const { trackId } = item.request.value;
      const entry = item.fileResults[0];
      const rendered = entry?.filename;
      if (!rendered || !rendered.startsWith(`${folder}/${trackId}-`) || !/^[\w-]+\.(?:ogg|webm|mp4|m4a)$/u.test(rendered.slice(folder.length + 1))
        || await realpath(rendered) !== rendered) throw new Error("录制文件无效");
      const name = rendered.slice(folder.length + 1);
      await store(rendered, name);
      const index = input.length / 2 + 2;
      input.push("-i", rendered);
      const offset = Math.max(0, Number((entry.startedAt || item.startedAt) / 1_000_000n) - start);
      indexEntries.push({ track: trackId, file: name, startUtc: new Date(start + offset).toISOString() });
      if (name.includes("-audio.")) {
        const label = `[a${index}]`;
        filters.push(`[${index}:a]adelay=${offset}:all=1${label}`);
        audio.push(label);
      } else {
        const source = `[v${index}]`;
        const target = `[o${index}]`;
        filters.push(`[${index}:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS+${offset / 1000}/TB${source}`);
        filters.push(`${video}${source}overlay=eof_action=pass:repeatlast=0${target}`);
        video = target;
      }
    }
    const meetingNumber = meeting.replace(/[^\w-]/gu, "").slice(-64);
    filters.push(`${video}drawtext=text='${meetingNumber} UTC %{pts\\:gmtime\\:${Math.floor(start / 1000)}}':x=16:y=16:fontsize=20:fontcolor=white:box=1:boxcolor=black[vout]`);
    filters.push(`[1:a]${audio.join("")}amix=inputs=${audio.length + 1}:duration=first:normalize=0[aout]`);
    const output = join(folder, "archive.ready.mp4");
    if (!await Bun.file(output).exists()) {
      const temporary = join(folder, `archive-${randomUUID()}.partial.mp4`);
      try {
        const process = Bun.spawn(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-filter_complex_threads", "1", "-f", "lavfi", "-i", "color=size=960x540:rate=25",
          "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000", ...input, "-filter_complex", filters.join(";"),
          "-map", "[vout]", "-map", "[aout]", "-t", String(duration), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
          "-c:a", "aac", "-movflags", "+faststart", temporary], { stdout: "ignore", stderr: "ignore" });
        if (await process.exited !== 0) throw new Error("离线视频合成失败");
        await rename(temporary, output);
      } finally { await rm(temporary, { force: true }); }
    }
    await store(output, "archive.mp4");
    artifacts.set("media-index.json", Buffer.from(JSON.stringify(indexEntries)));
    for (const key of requested) {
      this.requested.delete(key);
      this.failedStarts.delete(key);
      this.requests.delete(key);
    }
    return { files: artifacts, skipped };
  }
}

export function configuredTrackRecording() {
  const { MEETING_EGRESS_SPOOL: directory, MEETING_SFU_PRIVATE_URL: endpoint, MEETING_SFU_KEY: key, MEETING_SFU_SECRET: secret } = env;
  if (!directory) return;
  if (!endpoint || !key || !secret) throw new Error("轨道录制缺少私有 LiveKit 配置");
  return new MeetingTrackRecording(directory, new EgressClient(endpoint, key, secret, { requestTimeout: 5 }));
}
