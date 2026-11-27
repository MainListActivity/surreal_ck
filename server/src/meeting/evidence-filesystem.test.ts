import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateEvidenceDirectory } from "./evidence-filesystem";

test("初始化时创建私有存证目录并可在重启后读取", async () => {
  const parent = await mkdtemp(join(tmpdir(), "meeting-evidence-fs-"));
  try {
    const path = join(parent, "private", "evidence");
    const vault = privateEvidenceDirectory(path);
    expect((await stat(path)).mode & 0o7777).toBe(0o700);
    const bytes = Buffer.from("fixture");
    expect(await vault.create("ledger/object", bytes)).toBe(true);
    const reopened = privateEvidenceDirectory(path);
    expect(await reopened.read("ledger/object")).toEqual(bytes);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("初始化时拒绝权限过宽的存证目录且不修改权限", async () => {
  const parent = await mkdtemp(join(tmpdir(), "meeting-evidence-fs-"));
  try {
    const path = join(parent, "evidence");
    await mkdir(path);
    await chmod(path, 0o750);
    expect(() => privateEvidenceDirectory(path)).toThrow(/MEETING_EVIDENCE_DIR.*0700/u);
    expect((await stat(path)).mode & 0o7777).toBe(0o750);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
