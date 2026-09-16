import { readdir, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PlatformContentSchemaScript = { version: number; name: string; sql: string };

const FILE_PATTERN = /^(\d{3})-.+\.surql$/u;
const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));

function versions(names: string[]): Array<{ version: number; name: string }> {
  const files = names.flatMap((name) => {
    const match = FILE_PATTERN.exec(name);
    return match ? [{ version: Number(match[1]), name }] : [];
  });
  files.sort((left, right) => left.version - right.version);
  for (let index = 0; index < files.length; index += 1) {
    const expected = index + 1;
    if (files[index]?.version !== expected) {
      throw new Error(`platform content migration version ${String(expected).padStart(3, "0")} is missing`);
    }
    if (index > 0 && files[index - 1]?.version === files[index]?.version) {
      throw new Error(`platform content migration version ${String(expected).padStart(3, "0")} is duplicated`);
    }
  }
  return files;
}

const DEFAULT_FILES = versions(
  readdirSync(DEFAULT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name),
);

export const PLATFORM_CONTENT_SCHEMA_VERSION = DEFAULT_FILES.at(-1)?.version ?? 0;

export async function loadPlatformContentScripts(
  migrationsDir = DEFAULT_DIR,
): Promise<PlatformContentSchemaScript[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = versions(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  return Promise.all(
    files.map(async (file) => ({
      ...file,
      sql: await readFile(join(migrationsDir, file.name), "utf8"),
    })),
  );
}
