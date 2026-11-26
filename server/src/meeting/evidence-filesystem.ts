import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EvidenceObjects } from "./evidence-vault";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function privateEvidenceDirectory(path: string): EvidenceObjects {
  const directory = resolve(path);
  if (!isAbsolute(path) || directory === "/") throw new Error("MEETING_EVIDENCE_DIR 必须配置为独立的绝对路径");
  let root: string;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    root = realpathSync(directory);
    const info = statSync(root);
    if (root === "/" || !info.isDirectory() || (info.mode & 0o7777) !== 0o700) {
      throw new Error("会议存证目录必须是独立目录，且权限为 0700");
    }
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(`无法初始化 MEETING_EVIDENCE_DIR（${directory}）：请确认目录可由服务进程读写且权限为 0700`, { cause });
  }
  function locate(key: string): string {
    if (!key.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== "." && part !== "..")) {
      throw new Error("会议存证文件名无效");
    }
    return join(root, key);
  }
  return {
    async list(key) {
      try { return (await readdir(locate(key), { withFileTypes: true })).filter((entry) => entry.isFile()).map(({ name }) => name); }
      catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    },
    async read(key) {
      try { return await readFile(locate(key)); }
      catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    },
    async create(key, bytes) {
      const target = locate(key);
      const parent = dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const temporary = join(parent, `.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally { await file.close(); }
        try { await link(temporary, target); }
        catch (error) { if (hasCode(error, "EEXIST")) return false; throw error; }
        const directory = await open(parent);
        try { await directory.sync(); }
        finally { await directory.close(); }
        return true;
      } finally { await unlink(temporary); }
    },
  };
}
