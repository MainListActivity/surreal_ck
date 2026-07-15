import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TemplatePackScript = {
  name: string;
  fileName: string;
  sql: string;
};

export type LoadTemplatePackScriptsOptions = {
  selectedPacks: string[];
  packsDir?: string;
};

const DEFAULT_PACKS_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PACK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function loadTemplatePackScripts(
  options: LoadTemplatePackScriptsOptions,
): Promise<TemplatePackScript[]> {
  if (options.selectedPacks.length === 0) return [];
  const packsDir = options.packsDir ?? DEFAULT_PACKS_DIR;
  for (const name of options.selectedPacks) {
    if (!TEMPLATE_PACK_NAME_PATTERN.test(name)) {
      throw new Error(`invalid template pack name: ${name}`);
    }
  }

  return Promise.all(
    options.selectedPacks.map(async (name) => {
      const fileName = `${name}.surql`;
      let sql: string;
      try {
        sql = await readFile(join(packsDir, fileName), "utf8");
      } catch (cause) {
        if (isMissingFile(cause)) {
          throw new Error(`unknown template pack: ${name}`, { cause });
        }
        throw cause;
      }
      return {
        name,
        fileName,
        sql,
      };
    }),
  );
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
