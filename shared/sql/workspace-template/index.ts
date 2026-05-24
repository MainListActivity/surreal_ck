export type WorkspaceTemplateScript = {
  version: number;
  name: string;
  sql: string;
};

export type LoadTemplateScriptsOptions = {
  oidcJwksUrl?: string;
};

const OIDC_JWKS_URL_PLACEHOLDER = "<__OIDC_JWKS_URL__>";

const TEMPLATE_FILES = [
  { version: 1, name: "001-access.surql" },
  { version: 2, name: "002-tables-core.surql" },
  { version: 3, name: "003-tables-office.surql" },
  { version: 4, name: "004-workflow-run.surql" },
  { version: 5, name: "005-mastra-runtime-storage.surql" },
  { version: 6, name: "006-tables-grid.surql" },
] as const;

export const WORKSPACE_TEMPLATE_VERSION = TEMPLATE_FILES.at(-1)?.version ?? 0;

export async function loadTemplateScripts(options: LoadTemplateScriptsOptions = {}): Promise<WorkspaceTemplateScript[]> {
  return Promise.all(
    TEMPLATE_FILES.map(async (file) => {
      const rawSql = await Bun.file(new URL(file.name, import.meta.url)).text();

      return {
        ...file,
        sql: options.oidcJwksUrl ? rawSql.replaceAll(OIDC_JWKS_URL_PLACEHOLDER, options.oidcJwksUrl) : rawSql,
      };
    }),
  );
}
