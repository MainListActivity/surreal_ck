import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("封存可信根写入后杀死进程，重启自动补写投影且不重复封存", async () => {
  const directory = await mkdtemp(join(tmpdir(), "会议封存-"));
  const worker = (mode: string) => Bun.spawn([process.execPath, "--preload", "./test/setup-env.ts", "-e", `
    import { DateTime } from "surrealdb";
    import { MeetingEvidenceArchive } from "./src/meeting/evidence-archive";
    import { privateEvidenceDirectory } from "./src/meeting/evidence-filesystem";
    import { deriveEvidenceWorkspaceKey, EvidenceVault } from "./src/meeting/evidence-vault";
    const { directory, mode } = JSON.parse(process.env.FIXTURE);
    const workspace = "ws_fixture";
    const meeting = "daily:fixture";
    const at = "2026-11-26T08:00:00.000Z";
    const vault = new EvidenceVault(privateEvidenceDirectory(directory), deriveEvidenceWorkspaceKey(Buffer.alloc(32, 4)));
    const archive = new MeetingEvidenceArchive(vault, "fixture", 60, async () => ({
      async query(sql, args) {
        if (sql.startsWith("CREATE")) {
          if (mode === "first") {
            console.log("可信根已写入");
            await Bun.sleep(60_000);
          }
          await Bun.write(directory + "/projection.json", JSON.stringify(Buffer.from(args.projection.root_sha256).toString("hex")));
        }
        const projection = Bun.file(directory + "/projection.json");
        return (await projection.exists())
          ? [[{ meeting, root_sha256: Buffer.from(await projection.json(), "hex"),
            sealed_at: new DateTime(new Date(at)), retain_until: new DateTime(new Date(Date.parse(at) + 60 * 86400000)) }]]
          : [[]];
      },
    }));
    const jobs = archive.finalization(async (job) => {
      if (await archive.hasRoot(job.workspace, job.meeting)) {
        await archive.publish(job.workspace, job.meeting);
        return;
      }
      if (mode !== "first") throw new Error("不应重新封存");
      await archive.seal(job.workspace, job.meeting, job.at, {}, new Map([["media.bin", Buffer.from("fixture")]]));
    });
    if (mode === "first") await jobs.enqueue({ workspace, meeting, room: "fixture", kind: "daily", actor: "host", at });
    jobs.start();
    await jobs.resume();
    console.log((await archive.status(workspace, meeting)).root);
    process.exit(0);
  `], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, FIXTURE: JSON.stringify({ directory, mode }) },
    stdout: "pipe", stderr: "pipe" });
  const first = worker("first");
  let second: ReturnType<typeof worker> | undefined;
  try {
    const reader = first.stdout.getReader();
    const signaled = await Promise.race([reader.read(), Bun.sleep(4000).then(() => { throw new Error("子进程未进入投影写入"); })]);
    expect(new TextDecoder().decode(signaled.value)).toContain("可信根已写入");
    first.kill("SIGKILL");
    expect(await first.exited).not.toBe(0);
    second = worker("restart");
    const [result, stdout, stderr] = await Promise.all([second.exited, new Response(second.stdout).text(), new Response(second.stderr).text()]);
    expect(stderr).toBe("");
    expect(result).toBe(0);
    expect(stdout.trim()).toMatch(/^[a-f0-9]{64}$/u);
  } finally {
    first.kill();
    second?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
