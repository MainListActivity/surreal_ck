import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingEvidenceLedger, verifyEvidenceArtifact, verifyEvidenceManifest } from "./evidence-ledger";
import { deriveEvidenceWorkspaceKey, EvidenceVault, type EvidenceObjects } from "./evidence-vault";

const scope = { workspace: "ws_evidence", meeting: "meeting-42" };
const at = "2026-11-26T12:00:00.000Z";

function fixture() {
  const stored = new Map<string, Buffer>();
  const store: EvidenceObjects = {
    read: async (key) => stored.get(key) ?? null,
    create: async (key, value) => {
      if (stored.has(key)) return false;
      stored.set(key, Buffer.from(value));
      return true;
    },
  };
  return { stored, vault: new EvidenceVault(store, deriveEvidenceWorkspaceKey(Buffer.alloc(32, 42))) };
}

describe("独立会议存证", () => {
  test("对象写入时加密且不可覆盖，密文不能移至其他会议或工作区", async () => {
    const { stored, vault } = fixture();
    const plain = Buffer.from("会议记录中的个人信息");
    expect(await vault.create(scope, "track.mp4", plain)).toBe(true);
    expect(await vault.create(scope, "track.mp4", Buffer.from("替代"))).toBe(false);
    expect(await vault.read(scope, "track.mp4")).toEqual(plain);
    const ciphertext = stored.get("v1/ws_evidence/meeting-42/track.mp4")!;
    expect(ciphertext.includes(plain)).toBe(false);
    stored.set("v1/ws_evidence/meeting-43/track.mp4", ciphertext);
    stored.set("v1/ws_other/meeting-42/track.mp4", ciphertext);
    await expect(vault.read({ ...scope, meeting: "meeting-43" }, "track.mp4")).rejects.toThrow();
    await expect(vault.read({ ...scope, workspace: "ws_other" }, "track.mp4")).rejects.toThrow();
    await expect(vault.create(scope, "../secret", plain)).rejects.toThrow("路径无效");
  });

  test("并发只追加、重试幂等，封存后检测清单、视频、表决及工作区投影篡改", async () => {
    const { vault } = fixture();
    const ledger = new MeetingEvidenceLedger(vault);
    const vote = { id: "vote", kind: "vote", at, payload: { name: "示例", choice: "yes" } };
    const joined = { id: "joined", kind: "joined", at, payload: { subject: "subject-1" } };
    await Promise.all([ledger.append(scope, vote), ledger.append(scope, joined), ledger.append(scope, vote)]);
    const artifacts = new Map([["video.mp4", Buffer.from([1, 2, 3])], ["votes.json", Buffer.from('{"yes":1}')]]);
    const root = await ledger.seal(scope, at, { number: "42", mode: "roster" }, artifacts);
    expect(root).toHaveLength(32);
    expect(await ledger.seal(scope, at, { mode: "roster", number: "42" }, artifacts)).toEqual(root);
    const hex = root.toString("hex");
    const manifest = await ledger.verifiedManifest(scope, hex);
    expect(manifest.ledger.sequence).toBe(3);
    expect(manifest.files.map((item) => item.path)).toEqual(["ledger.json", "video.mp4", "votes.json"]);
    for (const item of manifest.files) expect((await ledger.readVerifiedArtifact(scope, item)).length).toBe(item.bytes);
    for (const [name, data] of artifacts) {
      const tampered = Buffer.from(data);
      tampered[0] = tampered[0]! ^ 1;
      expect(() => verifyEvidenceArtifact(manifest.files.find((item) => item.path === name)!, tampered)).toThrow("不匹配");
    }
    await expect(ledger.verifiedManifest(scope, "a".repeat(64))).rejects.toThrow("投影与可信根不匹配");
    await expect(ledger.verifiedManifest(scope, undefined)).rejects.toThrow("投影与可信根不匹配");
    expect(() => verifyEvidenceManifest(Buffer.from("{}"), root)).toThrow("清单 SHA-256 不匹配");
    await expect(ledger.append(scope, { ...vote, id: "late" })).rejects.toThrow("已封存");
    await expect(ledger.seal(scope, at, { number: "43" }, artifacts)).rejects.toThrow("与已冻结版本不同");
  });

  test("TSA 只接收 32 字节摘要，回执单独保留且不进入清单", async () => {
    const { vault } = fixture();
    const calls: Buffer[] = [];
    const receipt = Buffer.from("fixture timestamp receipt");
    const ledger = new MeetingEvidenceLedger(vault, {
      async timestamp(...args) {
        expect(args).toHaveLength(1);
        calls.push(Buffer.from(args[0]));
        return receipt;
      },
    });
    const artifacts = new Map([["votes.json", Buffer.from("私人业务正文")]]);
    const root = await ledger.seal(scope, at, { name: "私人名册" }, artifacts);
    await ledger.seal(scope, at, { name: "私人名册" }, artifacts);
    expect(calls).toEqual([root]);
    expect(calls[0]).toHaveLength(32);
    expect(await vault.read(scope, "tsa-response.bin")).toEqual(receipt);
    expect((await ledger.verifiedManifest(scope, root.toString("hex"))).files.map((item) => item.path))
      .toEqual(["ledger.json", "votes.json"]);
  });

  test("导出存证包可脱机校验，视频和表决记录的一字节篡改均被拒绝", async () => {
    const { vault } = fixture();
    const ledger = new MeetingEvidenceLedger(vault);
    const artifacts = new Map([["video.mp4", Buffer.from([1, 2, 3])], ["votes.json", Buffer.from('{"yes":1}')]]);
    const root = (await ledger.seal(scope, at, { number: "42" }, artifacts)).toString("hex");
    const archive = new Bun.Archive(await new Response(await ledger.exportPackage(scope, root)).blob());
    const report = await archive.files();
    expect([...report.keys()].sort()).toEqual(["VERIFICATION.txt", "ledger.json", "manifest.json", "video.mp4", "votes.json"]);
    const directory = await mkdtemp(join(tmpdir(), "meeting-evidence-"));
    try {
      await archive.extract(directory);
      const verify = () => Bun.spawnSync([
        "python3", "-B", join(import.meta.dir, "../../../scripts/verify-meeting-evidence.py"), directory, "--trusted-root", root,
      ]);
      const verified = verify();
      expect(verified.exitCode).toBe(0);
      expect(verified.stdout.toString()).toContain("会议存证校验通过: 3 项产物");
      for (const [name, bytes] of artifacts) {
        const tampered = Buffer.from(bytes);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
        await Bun.write(join(directory, name), tampered);
        const result = verify();
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(`产物 SHA-256 或长度不匹配: ${name}`);
        await Bun.write(join(directory, name), bytes);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("分块加密及 tar 流保留跨块视频的精确大小和 SHA-256", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meeting-chunks-"));
    try {
      const { vault } = fixture();
      const ledger = new MeetingEvidenceLedger(vault);
      const media = join(directory, "source");
      const video = Buffer.alloc(9 * 1024 * 1024 + 17, 14);
      await Bun.write(media, video);
      const path = "video-" + "long".repeat(25) + ".mp4";
      const root = (await ledger.seal(scope, at, null, new Map([[path, Bun.file(media)]]))).toString("hex");
      const item = (await ledger.verifiedManifest(scope, root)).files.find((file) => file.path === path)!;
      expect(item.parts).toBe(3);
      expect(item.bytes).toBe(video.length);
      const tar = join(directory, "evidence.tar");
      const writer = Bun.file(tar).writer();
      for await (const chunk of await ledger.exportPackage(scope, root)) writer.write(chunk);
      await writer.end();
      expect(Bun.spawnSync(["tar", "-xf", tar, "-C", directory]).stderr.toString()).toBe("");
      expect(await Bun.file(join(directory, path)).size).toBe(video.length);
      expect(Bun.spawnSync(["python3", "../scripts/verify-meeting-evidence.py", directory, "--trusted-root", root]).exitCode).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
