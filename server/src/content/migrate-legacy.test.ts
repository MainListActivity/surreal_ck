import { describe, expect, test } from "bun:test";
import {
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
