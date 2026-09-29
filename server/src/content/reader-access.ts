import { readFile } from "node:fs/promises";
import type { PlatformContentSchemaClient } from "./schema";

/** Configuration values are parameters, never string-interpolated SQL. */
export async function defineContentReaderAccess(
  db: Pick<PlatformContentSchemaClient, "query">,
  config: { jwksUrl: string; issuer: string; audience: string },
): Promise<void> {
  const raw = await readFile(new URL("./reader-access.surql", import.meta.url), "utf8");
  const sql = raw.replace('"<__CONTENT_JWKS__>"', () => JSON.stringify(config.jwksUrl))
    .replaceAll('"<__CONTENT_AUDIENCE__>"', () => JSON.stringify(config.audience))
    .replace('"<__CONTENT_ISSUER__>"', () => JSON.stringify(config.issuer));
  await db.query(sql);
}
