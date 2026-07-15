import { readdir, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkspaceTemplateScript = {
  version: number;
  name: string;
  sql: string;
};

export type LoadTemplateScriptsOptions = {
  migrationsDir?: string;
  oidcJwksUrl?: string;
};

const OIDC_JWKS_URL_PLACEHOLDER = "<__OIDC_JWKS_URL__>";

type TemplateFile = Pick<WorkspaceTemplateScript, "version" | "name">;

const TEMPLATE_FILE_PATTERN = /^(\d{3})-.+\.surql$/;
const DEFAULT_MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

function toTemplateFile(name: string): TemplateFile | null {
  const match = TEMPLATE_FILE_PATTERN.exec(name);
  return match ? { version: Number(match[1]), name } : null;
}

function sortByVersion(files: TemplateFile[]): TemplateFile[] {
  return files.sort((left, right) => left.version - right.version);
}

function rejectDuplicateVersions(files: TemplateFile[]): void {
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous?.version === current?.version) {
      throw new Error(`workspace template migration version ${String(current.version).padStart(3, "0")} is duplicated`);
    }
  }
}

function rejectVersionGaps(files: TemplateFile[]): void {
  for (let index = 0; index < files.length; index += 1) {
    const expectedVersion = index + 1;
    if (files[index]?.version !== expectedVersion) {
      throw new Error(
        `workspace template migration version ${String(expectedVersion).padStart(3, "0")} is missing`,
      );
    }
  }
}

async function discoverTemplateFiles(migrationsDir: string): Promise<TemplateFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const invalidFile = entries.find(
    (entry) => entry.isFile() && entry.name.endsWith(".surql") && !TEMPLATE_FILE_PATTERN.test(entry.name),
  );
  if (invalidFile) {
    throw new Error(`invalid workspace template migration filename: ${invalidFile.name}`);
  }
  const files = sortByVersion(
    entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const file = toTemplateFile(entry.name);
      return file ? [file] : [];
    }),
  );
  rejectDuplicateVersions(files);
  rejectVersionGaps(files);
  return files;
}

const DEFAULT_TEMPLATE_FILES = sortByVersion(
  readdirSync(DEFAULT_MIGRATIONS_DIR, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = toTemplateFile(entry.name);
    return file ? [file] : [];
  }),
);

export const WORKSPACE_TEMPLATE_VERSION = DEFAULT_TEMPLATE_FILES.at(-1)?.version ?? 0;

export async function loadTemplateScripts(options: LoadTemplateScriptsOptions = {}): Promise<WorkspaceTemplateScript[]> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = await discoverTemplateFiles(migrationsDir);

  return Promise.all(
    files.map(async (file) => {
      const rawSql = await readFile(join(migrationsDir, file.name), "utf8");

      return {
        ...file,
        sql: options.oidcJwksUrl ? rawSql.replaceAll(OIDC_JWKS_URL_PLACEHOLDER, options.oidcJwksUrl) : rawSql,
      };
    }),
  );
}
