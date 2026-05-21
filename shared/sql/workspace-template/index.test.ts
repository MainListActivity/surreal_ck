import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, WORKSPACE_TEMPLATE_VERSION } from "@surreal-ck/shared/workspace-template";

describe("workspace template scripts", () => {
  test("loads workspace template scripts in version order from the shared template directory", async () => {
    const scripts = await loadTemplateScripts();

    expect(WORKSPACE_TEMPLATE_VERSION).toBe(3);
    expect(scripts.map((script) => script.version)).toEqual([1, 2, 3]);
    expect(scripts.map((script) => script.name)).toEqual([
      "001-access.surql",
      "002-tables-core.surql",
      "003-tables-office.surql",
    ]);
    expect(scripts[0]?.sql).toContain("DEFINE ACCESS admin");
    expect(scripts[1]?.sql).toContain("DEFINE TABLE IF NOT EXISTS user");
    expect(scripts[2]?.sql).toContain("DEFINE TABLE IF NOT EXISTS employee_credential");
  });

  test("keeps JWT access placeholders by default and can render them for backend execution", async () => {
    const rawScripts = await loadTemplateScripts();
    const rawSql = rawScripts.map((script) => script.sql).join("\n");

    expect(rawSql.match(/<__OIDC_JWKS_URL__>/g)?.length).toBe(2);
    expect(rawScripts[0]?.sql).toContain("DEFINE ACCESS employee");
    expect(rawScripts[0]?.sql).not.toContain("DEFINE ACCESS employee ON DATABASE TYPE RECORD\n  WITH JWT");

    const renderedScripts = await loadTemplateScripts({
      oidcJwksUrl: "https://issuer.example.test/jwks.json",
    });
    const renderedSql = renderedScripts.map((script) => script.sql).join("\n");

    expect(renderedSql).not.toContain("<__OIDC_JWKS_URL__>");
    expect(renderedSql.match(/https:\/\/issuer\.example\.test\/jwks\.json/g)?.length).toBe(2);
  });
});
