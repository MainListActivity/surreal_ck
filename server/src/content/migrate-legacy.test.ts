import { describe, expect, test } from "bun:test";
import { BoundExcluded, RecordId, RecordIdRange } from "surrealdb";
import {
  assertLegacyContentMigrated,
  legacyContentMigrationCompleted,
  migrateLegacyPlatformContentIfNeeded,
} from "./migrate-legacy";

function fakeDb(targetRows: unknown[] = []) {
  return {
    async query(sql: string): Promise<unknown> {
      if (sql.includes("content_migration_state")) return [targetRows];
      return [[]];
    },
    select() { throw new Error("select must not run after the migration marker exists"); },
    create() { throw new Error("create must not run after the migration marker exists"); },
    relate() { throw new Error("relate must not run after the migration marker exists"); },
    upsert() { throw new Error("upsert must not run after the migration marker exists"); },
  };
}

describe("legacy content migration marker", () => {
  test("verified marker completes the one-shot migration", async () => {
    const target = fakeDb([{ source_database: "_system", verified_at: new Date() }]);
    await expect(legacyContentMigrationCompleted(target)).resolves.toBe(true);
  });

  test("missing, wrong-source or unverified markers do not complete it", async () => {
    await expect(legacyContentMigrationCompleted(fakeDb())).resolves.toBe(false);
    await expect(legacyContentMigrationCompleted(
      fakeDb([{ source_database: "other", verified_at: new Date() }]),
    )).resolves.toBe(false);
    await expect(legacyContentMigrationCompleted(
      fakeDb([{ source_database: "_system", verified_at: null }]),
    )).resolves.toBe(false);
  });

  test("marker short-circuits without touching the copy path", async () => {
    const source = { async query() { throw new Error("source must not be read when migrated"); } };
    const target = fakeDb([{ source_database: "_system", verified_at: new Date() }]);
    await expect(migrateLegacyPlatformContentIfNeeded({
      source, target, writesFrozen: true,
    })).resolves.toBe("already-migrated");
  });

  test("writesFrozen is still required before anything runs", async () => {
    const target = fakeDb([{ source_database: "_system", verified_at: new Date() }]);
    await expect(migrateLegacyPlatformContentIfNeeded({
      source: { async query() { return [[]]; } }, target, writesFrozen: false,
    })).rejects.toThrow("writes must be frozen");
  });
});

function copyDb(content: Record<string, unknown>, revision: bigint) {
  return {
    async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
      if (sql === "INFO FOR DB;") return [{ tables: { content_version: "DEFINE TABLE content_version" } }];
      if (sql === "SELECT VALUE count() FROM content_version GROUP ALL;") return [[1]];
      if (sql.startsWith("SELECT * FROM $range ") && params?.range instanceof RecordIdRange &&
        params.range.table.name === "content_version") {
        return [[{ id: "content_version:fixture", revision, content_kind_payload: content }]];
      }
      if (sql.includes("content_migration_state")) return [[{ source_database: "_system" }]];
      return [[]];
    },
  };
}

describe("legacy content startup verification", () => {
  test("uses a key-only count and does not read record values when legacy tables are empty", async () => {
    const queries: string[] = [];
    const source = {
      async query(sql: string) {
        queries.push(sql);
        return sql === "INFO FOR DB;" ? [{ tables: { ingestion_batch: "" } }] : [[]];
      },
    };
    const target = { async query() { throw new Error("no legacy content"); } };
    await assertLegacyContentMigrated(source, target);
    expect(queries).toEqual(["INFO FOR DB;", "SELECT VALUE count() FROM ingestion_batch GROUP ALL;"]);
  });

  test("advances a bounded range using the typed last key and verifies later pages", async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: new RecordId("ingestion_batch", i),
      receipt: `row-${i}`,
    }));
    function db(contents: typeof records) {
      return {
        async query(sql: string, params?: Record<string, unknown>): Promise<unknown> {
          if (sql === "INFO FOR DB;") return [{ tables: { ingestion_batch: "" } }];
          if (sql === "SELECT VALUE count() FROM ingestion_batch GROUP ALL;") return [[10n]];
          if (sql.includes("content_migration_state")) return [[{ source_database: "_system" }]];
          expect(sql).toBe("SELECT * FROM $range LIMIT 8;");
          const range = params?.range;
          expect(range).toBeInstanceOf(RecordIdRange);
          if (!(range instanceof RecordIdRange) || range.table.name !== "ingestion_batch") return [[]];
          if (!range.begin) return [contents.slice(0, 8)];
          expect(range.begin).toEqual(new BoundExcluded(7));
          return [contents.slice(8)];
        },
      };
    }
    await expect(assertLegacyContentMigrated(db(records), db(records))).resolves.toBeUndefined();
    const changed = records.map((row, i) => i === 9 ? { ...row, receipt: "changed" } : row);
    await expect(assertLegacyContentMigrated(db(records), db(changed)))
      .rejects.toThrow("content migration mismatch");
  });

  test("deepVerify false skips row comparison only when the marker is verified", async () => {
    const reads: string[] = [];
    function db(marker: Record<string, unknown>) {
      return {
        async query(sql: string): Promise<unknown> {
          if (sql === "INFO FOR DB;") return [{ tables: { ingestion_batch: "" } }];
          if (sql === "SELECT VALUE count() FROM ingestion_batch GROUP ALL;") return [[10n]];
          if (sql.includes("content_migration_state")) return [[marker]];
          reads.push(sql);
          return [[]];
        },
      };
    }
    const verified = db({ source_database: "_system", verified_at: "2026-11-01T00:00:00Z" });
    await assertLegacyContentMigrated(verified, verified, { deepVerify: false });
    expect(reads).toEqual([]);
    const unverified = db({ source_database: "_system" });
    await assertLegacyContentMigrated(unverified, unverified, { deepVerify: false });
    expect(reads.length).toBeGreaterThan(0);
  });

  test("accepts equal BigInts in migrated rows and nested payloads, ignoring field order and timestamps", async () => {
    const source = copyDb({ values: [{ amount: 9_007_199_254_740_993n }], label: "fixture", updated_at: "source" }, 1n);
    const target = copyDb({ label: "fixture", updated_at: "target", values: [{ amount: 9_007_199_254_740_993n }] }, 1n);
    await assertLegacyContentMigrated(source, target);
  });

  test.each([
    ["an adjacent integer above the safe number range", 9_007_199_254_740_992n],
    ["a string with identical digits", "9007199254740993"],
  ])("rejects %s in a migrated payload", async (_description, amount) => {
    const source = copyDb({ values: [9_007_199_254_740_993n] }, 1n);
    const target = copyDb({ values: [amount] }, 1n);
    await expect(assertLegacyContentMigrated(source, target))
      .rejects.toThrow("content migration mismatch in content_version/content_version:fixture");
  });
});
