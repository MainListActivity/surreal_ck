import { describe, expect, test } from "bun:test";
import { SurrealNativeQuotaClient } from "./client";

function readyInfo(database: string) {
  return {
    database,
    format_version: 1,
    latest_change: null,
    ledger: {
      active_epoch: 1,
      state: "ready",
      usage_trusted: true,
    },
    observed_at: "2026-07-25T12:00:00.000Z",
    policy: null,
    usage: {
      table_buckets: [],
      tables: [],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

describe("SurrealNativeQuotaClient", () => {
  test("keeps quota grammar inside the adapter and returns a typed INFO DTO", async () => {
    const queries: string[] = [];
    const client = new SurrealNativeQuotaClient({
      async query(sql) {
        queries.push(sql);
        return [readyInfo("_system")];
      },
    });

    await expect(client.info("_system")).resolves.toEqual(readyInfo("_system"));
    expect(queries).toEqual([
      "INFO FOR QUOTA ON DATABASE _system STRUCTURE;",
    ]);
  });

  test("rejects database identifiers before constructing SurrealQL", async () => {
    const client = new SurrealNativeQuotaClient({
      async query() {
        throw new Error("must not query");
      },
    });

    await expect(client.info("ws_demo; REMOVE DATABASE _system")).rejects.toThrow(
      "Invalid native quota database identifier",
    );
  });
});

