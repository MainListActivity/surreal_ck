import { Surreal } from "surrealdb";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";

export type ContentProjectionClient = Pick<Surreal, "query">;
let session: Surreal | null = null;
let secret: string | null = null;
let signedAt = 0;
let renewing: Promise<void> | null = null;

/** Startup-only root maintenance; the process owns a transient RECORD credential. */
export async function initContentProjectionSession(): Promise<void> {
  const root = await getRootDatabaseSession(env.CONTENT_DATABASE);
  const pass = crypto.randomUUID() + crypto.randomUUID();
  await root.query(`
    INSERT INTO content_projection_identity { id: content_projection_identity:server, active: true }
      ON DUPLICATE KEY UPDATE active = true;
    INSERT INTO content_projection_credential { id: content_projection_credential:server, secret_hash: crypto::argon2::generate($pass) }
      ON DUPLICATE KEY UPDATE secret_hash = crypto::argon2::generate($pass);
  `, { pass });
  const db = new Surreal();
  try {
    await db.connect(env.SURREAL_URL, { namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE });
    await db.signin({ namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE, access: "content_projection_sync", variables: { pass } });
    session = db; secret = pass; signedAt = Date.now();
  } catch {
    await db.close();
    throw new Error("content projection initialization failed");
  }
}

export async function getContentProjectionSession(): Promise<ContentProjectionClient> {
  const db = session;
  const pass = secret;
  if (!db || !pass) throw new Error("content projection unavailable");
  if (Date.now() - signedAt > 600_000) {
    renewing ??= db.signin({ namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE, access: "content_projection_sync", variables: { pass } })
      .then(() => { signedAt = Date.now(); }).finally(() => { renewing = null; });
    await renewing;
  }
  return db;
}

export async function closeContentProjectionSession(): Promise<void> {
  const db = session; session = null; secret = null;
  await db?.close();
}
