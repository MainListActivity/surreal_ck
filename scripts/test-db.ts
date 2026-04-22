/**
 * Integration test for surrealdb-node embedded mode.
 * Run with: bun run scripts/test-db.ts
 *
 * Cannot run inside `bun test` due to NAPI worker thread incompatibility in Bun 1.3.x.
 */
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, err: unknown) {
  console.error(`  ✗ ${label}:`, err);
  failed++;
}

const db = new Surreal({ engines: { ...createNodeEngines() } });

try {
  await db.connect("mem://");
  ok("connect mem://");
} catch (e) {
  fail("connect mem://", e);
}

try {
  await db.use({ namespace: "test", database: "test" });
  ok("use namespace/database");
} catch (e) {
  fail("use namespace/database", e);
}

try {
  const r = await db.query("RETURN 42");
  if (JSON.stringify(r) === "[42]") ok("RETURN 42 query");
  else fail("RETURN 42 query", `unexpected result: ${JSON.stringify(r)}`);
} catch (e) {
  fail("RETURN 42 query", e);
}

try {
  await db.query("CREATE test_item SET name = 'scaffold-test'");
  const rows = await db.query<{ name: string }[][]>("SELECT name FROM test_item");
  if (rows[0]?.[0]?.name === "scaffold-test") ok("CREATE/SELECT round-trip");
  else fail("CREATE/SELECT round-trip", `unexpected rows: ${JSON.stringify(rows)}`);
} catch (e) {
  fail("CREATE/SELECT round-trip", e);
}

try {
  await db.query("INVALID SQL @@@@");
  fail("invalid SQL should throw", "no error thrown");
} catch {
  ok("invalid SQL throws error");
}

// Load actual schema (DEFINE BUCKET requires --allow-experimental files flag, skip that statement)
try {
  const schema = await Bun.file("./schema/main.surql").text();
  const schemaNoBucket = schema.replace(/DEFINE BUCKET[^;]*;/gs, "-- BUCKET skipped (experimental)");
  await db.query(schemaNoBucket);
  ok("schema/main.surql loaded (BUCKET statements skipped — require experimental flag)");
} catch (e) {
  fail("schema/main.surql loaded", e);
}

console.log(`\n${passed} passed, ${failed} failed`);
// Exit without db.close() to avoid segfault on Bun 1.3.x
process.exit(failed > 0 ? 1 : 0);
