import { Surreal } from "surrealdb";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };

let publisher: Surreal | null = null;
let signedInAt = 0;
let renewing: Promise<void> | null = null;

/** Root only provisions or rotates the credential, never executes content DML. */
export async function provisionContentPublisher(root: Queryable, secret: string): Promise<void> {
  if (secret.length < 32) throw new Error("CONTENT_PUBLISHER_SECRET must have at least 32 characters");
  await root.query(
    "INSERT INTO content_publisher_identity { id: content_publisher_identity:server, active: true } ON DUPLICATE KEY UPDATE active = active;",
  );
  await root.query(
    "UPSERT content_publisher_credential:server CONTENT { publisher: content_publisher_identity:server, secret_hash: crypto::argon2::generate($pass) };",
    { pass: secret },
  );
}

export async function initContentPublisherSession(): Promise<void> {
  const secret = env.CONTENT_PUBLISHER_SECRET;
  if (!secret) throw new Error("CONTENT_PUBLISHER_SECRET is required for isolated content publishing");
  const root = await getRootDatabaseSession(env.CONTENT_DATABASE);
  await provisionContentPublisher(root, secret);
  const db = new Surreal();
  try {
    await db.connect(env.SURREAL_URL, { namespace: env.SURREAL_NS, database: env.CONTENT_DATABASE });
    await db.signin({
      namespace: env.SURREAL_NS,
      database: env.CONTENT_DATABASE,
      access: "content_publisher",
      variables: { pass: secret },
    });
    publisher = db;
    signedInAt = Date.now();
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function currentPublisher(): Promise<Surreal> {
  if (!publisher) throw new Error("content publisher session is not initialized");
  if (Date.now() - signedInAt > 10 * 60_000) {
    renewing ??= (async () => {
      const secret = env.CONTENT_PUBLISHER_SECRET;
      if (!secret) throw new Error("CONTENT_PUBLISHER_SECRET is required");
      await publisher!.signin({
        namespace: env.SURREAL_NS,
        database: env.CONTENT_DATABASE,
        access: "content_publisher",
        variables: { pass: secret },
      });
      signedInAt = Date.now();
    })().finally(() => { renewing = null; });
    await renewing;
  }
  return publisher;
}

export const contentPublisherQuery: Queryable = {
  async query(sql, params) {
    return (await currentPublisher()).query(sql, params);
  },
};

export async function closeContentPublisherSession(): Promise<void> {
  const db = publisher;
  publisher = null;
  signedInAt = 0;
  if (db) await db.close();
}
