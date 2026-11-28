import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressClient, RoomServiceClient } from "livekit-server-sdk";
import { DateTime } from "surrealdb";
import { MeetingEvidenceArchive } from "./evidence-archive";
import { privateEvidenceDirectory } from "./evidence-filesystem";
import { MeetingTrackRecording } from "./evidence-recording";
import { deriveEvidenceWorkspaceKey, EvidenceVault } from "./evidence-vault";

const { M13_TEST_LK_CLI: cli, M13_TEST_SPOOL: spool, M13_TEST_ENDPOINT: endpoint,
  M13_TEST_KEY: key, M13_TEST_SECRET: secret } = process.env;

test.skipIf(!cli || !spool || !endpoint || !key || !secret)("真实 Track Egress：结束、合成、加密封存、审计下载及离线核验", async () => {
  const room = randomUUID();
  const roomName = `ck-meeting-${room}`;
  const folders = await mkdtemp(join(tmpdir(), "m13-recording-"));
  const api = new RoomServiceClient(endpoint!, key, secret);
  const recording = new MeetingTrackRecording(spool!, new EgressClient(endpoint!, key, secret));
  const subscribers = process.env.M13_LOAD_SUBSCRIBERS ?? "0";
  const bot = Bun.spawn([cli!, "load-test", "--url", endpoint!, "--room", roomName, "--video-resolution", "low",
    "--video-publishers", "1", "--audio-publishers", "1", "--subscribers", subscribers, "--duration", "16s"],
  { env: { ...process.env, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret }, stdout: "pipe", stderr: "pipe" });
  try {
    const videoOutput = new Response(bot.stdout).text();
    const diagnostics = new Response(bot.stderr).text();
    const start = Date.now();
    await recording.ready();
    let tracks: { sid: string; type: number }[] = [];
    for (let retry = 0; retry < 60 && tracks.length < 2; retry++) {
      await Bun.sleep(200);
      tracks = (await api.listParticipants(roomName).catch(() => [])).flatMap((participant) => participant.tracks);
    }
    if (tracks.length < 2) throw new Error(await diagnostics);
    expect(tracks).toHaveLength(2);
    await Promise.all(tracks.map((track) => recording.start(roomName, track.sid, track.type === 0, Date.now())));
    for (let retry = 0; retry < 24 && !await recording.canStop(room); retry++) await Bun.sleep(500);
    expect(await recording.canStop(room)).toBe(true);
    await Bun.sleep(1500);
    const end = Date.now();
    await recording.stop(room);
    expect(bot.exitCode).toBeNull();
    expect((await api.listParticipants(roomName)).length).toBeGreaterThan(0);
    expect(await bot.exited).toBe(0);
    const loadOutput = await videoOutput;
    if (subscribers !== "0") console.info(loadOutput.split("\n").filter((line) => line.includes("Total")).join("\n"));
    await api.deleteRoom(roomName);
    const { files: artifacts } = await recording.collect(room, "m13-test", start, end);
    expect([...artifacts.keys()].filter((name) => name.includes("-audio."))).toHaveLength(1);
    expect([...artifacts.keys()].filter((name) => name.includes("-video."))).toHaveLength(1);
    expect((artifacts.get("archive.mp4") as Blob | undefined)?.size).toBeGreaterThan(1000);
    let projection: Record<string, unknown> | undefined;
    let now = end;
    const vault = new EvidenceVault(privateEvidenceDirectory(folders), deriveEvidenceWorkspaceKey(Buffer.alloc(32, 42)));
    const archive = new MeetingEvidenceArchive(vault, "fixture archive key", 31, async () => ({
      async query(sql, vars) {
        if (sql.startsWith("CREATE")) projection = vars?.projection as Record<string, unknown>;
        return [projection ? [projection] : []];
      },
    }), () => now);
    const meeting = "m13-test";
    const workspace = "ws_evidence";
    await archive.append(workspace, meeting, { id: "consent", kind: "consent", at: new Date(start).toISOString(), payload: { subject: "host" } });
    await archive.seal(workspace, meeting, new Date(end).toISOString(), {}, artifacts);
    const { token, root, backupReminder } = await archive.grant(workspace, meeting, "host");
    expect(backupReminder).toBe(false);
    await expect(archive.download("other_workspace", meeting, "host", token)).rejects.toMatchObject({ status: 403 });
    await expect(archive.download(workspace, meeting, "member", token)).rejects.toMatchObject({ status: 403 });
    const content = await archive.download(workspace, meeting, "host", token);
    await expect(archive.download(workspace, meeting, "host", token)).rejects.toMatchObject({ status: 403 });
    const writer = Bun.file(join(folders, "package.tar")).writer();
    for await (const chunk of content) writer.write(chunk);
    await writer.end();
    expect(Bun.spawnSync(["tar", "-xf", join(folders, "package.tar"), "-C", folders]).exitCode).toBe(0);
    const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", join(folders, "archive.mp4")]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim().split("\n")).toEqual(["video", "audio"]);
    const verify = Bun.spawnSync(["python3", "../scripts/verify-meeting-evidence.py", folders, "--trusted-root", root]);
    expect(verify.stderr.toString()).toBe("");
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout.toString()).toContain("会议存证校验通过");
    const mp4 = await Bun.file(join(folders, "archive.mp4")).bytes();
    mp4[mp4.length - 1] ^= 1;
    await Bun.write(join(folders, "archive.mp4"), mp4);
    const tampered = Bun.spawnSync(["python3", "../scripts/verify-meeting-evidence.py", folders, "--trusted-root", root]);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr.toString()).toContain("archive.mp4");
    now += 2 * 86_400_000;
    expect((await archive.status(workspace, meeting)).backupReminder).toBe(true);
    projection!.retain_until = new DateTime(new Date(end));
    await expect(archive.status(workspace, meeting)).rejects.toMatchObject({ status: 409 });
  } finally {
    bot.kill();
    await api.deleteRoom(roomName).catch(() => undefined);
    await rm(folders, { recursive: true, force: true });
    await rm(join(spool!, roomName), { recursive: true, force: true });
  }
}, 55_000);
