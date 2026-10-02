import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { AUDIT_ACTIONS } from "./service";

const migrationsDirectoryUrl = new URL("../../../shared/sql/system/", import.meta.url);

/** 取 system 迁移按版本序应用后，product_entitlement_audit.action 的最终 ASSERT 白名单。 */
async function effectiveAuditActionWhitelist(): Promise<string[]> {
  const entries = (await readdir(migrationsDirectoryUrl))
    .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
    .sort();
  const fieldPattern =
    /DEFINE FIELD\s+(?:IF NOT EXISTS\s+|OVERWRITE\s+)?action\s+ON\s+TABLE\s+product_entitlement_audit\b[\s\S]*?;/gu;
  const listPattern = /ASSERT\s+\$value\s+INSIDE\s*\[([\s\S]*?)\]/u;
  let whitelist: string[] | null = null;
  for (const entry of entries) {
    const sql = await readFile(new URL(entry, migrationsDirectoryUrl), "utf8");
    for (const match of sql.matchAll(fieldPattern)) {
      const list = match[0].match(listPattern);
      if (!list) continue;
      whitelist = [...list[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
    }
  }
  if (!whitelist) throw new Error("missing product_entitlement_audit.action assert");
  return whitelist;
}

describe("product_entitlement_audit.action schema assert", () => {
  test("schema whitelist covers exactly the service audit actions", async () => {
    const whitelist = await effectiveAuditActionWhitelist();
    expect([...whitelist].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
