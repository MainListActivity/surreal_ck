import { readFile } from "node:fs/promises";
import { exportSPKI } from "jose";
import { defineContentReaderAccess } from "../src/content/reader-access";
import type { PlatformContentSchemaClient } from "../src/content/schema";

/** Local fork builds may omit jwks. Explicit fixture mode still uses real signed
 * RECORD JWTs and the unmodified production AUTHENTICATE/PERMISSIONS clauses.
 * The default CI path continues to exercise JWKS. Never used by the application. */
export async function defineReaderFixture(
  db: Pick<PlatformContentSchemaClient, "query">,
  config: { jwksUrl: string; issuer: string; audience: string },
  publicKey: CryptoKey,
): Promise<void> {
  if (process.env.LOCAL_CONTENT_FIXTURE_STATIC_KEY !== "1") return defineContentReaderAccess(db, config);
  const template = await readFile(new URL("../src/content/reader-access.surql", import.meta.url), "utf8");
  const sql = template.replace('WITH JWT URL "<__CONTENT_JWKS__>"',
    `WITH JWT ALGORITHM ES256 KEY ${JSON.stringify(await exportSPKI(publicKey))}`)
    .replaceAll('"<__CONTENT_AUDIENCE__>"', JSON.stringify(config.audience))
    .replace('"<__CONTENT_ISSUER__>"', JSON.stringify(config.issuer));
  await db.query(sql);
}
