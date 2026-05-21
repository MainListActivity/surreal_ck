import { describe, test, expect } from "bun:test";
import { getLocalDb, getRemoteDb } from "./index";

// NOTE: @surrealdb/node NAPI integration tests cannot run inside `bun test` runner
// due to a known Bun 1.3.x incompatibility with NAPI worker threads (hangs indefinitely).
// Use `scripts/test-db.ts` for manual integration verification: `bun run scripts/test-db.ts`

describe("DB module (unit guards)", () => {
  test("getLocalDb throws before initEngine", () => {
    expect(() => getLocalDb()).toThrow("[db] Engine not initialized");
  });

  test("getRemoteDb returns null when no remote connection", () => {
    expect(getRemoteDb()).toBeNull();
  });
});
