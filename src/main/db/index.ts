import { join } from "node:path";
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

let _db: Surreal | null = null;

export async function initDb(): Promise<Surreal> {
  if (_db) return _db;

  const db = new Surreal({
    engines: {
      ...createNodeEngines(),
    },
  });

  await db.connect("surrealkv://./data/app.db");
  await db.use({ namespace: "surreal_ck", database: "main" });

  const schemaRaw = await Bun.file(join(import.meta.dir, "schema/main.surql")).text();
  // DEFINE BUCKET requires SurrealDB experimental files feature; strip until enabled
  const schema = schemaRaw.replace(/DEFINE BUCKET[^;]*;/gs, "");
  await db.query(schema);

  _db = db;
  console.log("[db] initialized");
  return db;
}

export function getDb(): Surreal {
  if (!_db) throw new Error("DB not initialized — call initDb() first");
  return _db;
}

export async function closeDb(): Promise<void> {
  // NOTE: db.close() on surrealdb-node 3.x causes a segfault on Bun 1.3.x at process exit.
  // The embedded engine is cleaned up when the process exits naturally.
  // This function is a no-op until the upstream issue is resolved.
  _db = null;
}
