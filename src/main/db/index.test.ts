import { describe, test, expect } from "bun:test";
import { getDb, closeDb } from "./index";

// NOTE: @surrealdb/node NAPI integration tests cannot run inside `bun test` runner
// due to a known Bun 1.3.x incompatibility with NAPI worker threads (hangs indefinitely).
// Use `scripts/test-db.ts` for manual integration verification: `bun run scripts/test-db.ts`

describe("DB module (unit guards)", () => {
  test("getDb throws with correct message before initDb", () => {
    expect(() => getDb()).toThrow("DB not initialized");
  });

  test("closeDb is a no-op (segfault workaround)", async () => {
    await expect(closeDb()).resolves.toBeUndefined();
  });
});
