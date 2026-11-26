import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EvidenceObjects } from "./evidence-vault";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function privateEvidenceDirectory(path: string): EvidenceObjects {
  if (!isAbsolute(path) || resolve(path) === "/") throw new Error("会议存证目录必须独立配置为绝对路径");
  let root: Promise<string> | undefined;
  async function locate(key: string): Promise<string> {
    if (!key.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== "." && part !== "..")) {
      throw new Error("会议存证文件名无效");
    }
    root ??= (async () => {
      const base = await realpath(path);
      const info = await stat(base);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("会议存证目录必须为进程私有");
      return base;
    })();
    return join(await root, key);
  }
  return {
    async list(key) {
      try { return (await readdir(await locate(key), { withFileTypes: true })).filter((entry) => entry.isFile()).map(({ name }) => name); }
      catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    },
    async read(key) {
      try { return await readFile(await locate(key)); }
      catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    },
    async create(key, bytes) {
      const target = await locate(key);
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
