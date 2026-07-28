import { describe, expect, test } from "bun:test";
import { DateTime, StringRecordId } from "surrealdb";
import { SurrealLifecycleBoundarySweepHandler } from "./lifecycle-sweep";
import type { EntitlementRefreshPort } from "./subscription-lifecycle";

const now = new DateTime("2026-08-08T00:00:00.000Z");

describe("SurrealLifecycleBoundarySweepHandler", () => {
  test("refreshes each due workspace and advances a stable record cursor", async () => {
    let params: Record<string, unknown> | undefined;
    const calls: Parameters<EntitlementRefreshPort["refreshWorkspace"]>[0][] =
      [];
    const handler = new SurrealLifecycleBoundarySweepHandler(
      {
        async query(_sql, queryParams) {
          params = queryParams;
          return [[
            { id: new StringRecordId("workspace:acme") },
            { id: new StringRecordId("workspace:beta") },
          ]];
        },
      },
      {
        async refreshWorkspace(input) {
          calls.push(input);
          return {};
        },
      },
      { now: () => now },
    );

    await expect(handler.processPage({
      cursor: "workspace:aardvark",
      limit: 2,
      fencingToken: 7,
    })).resolves.toEqual({
      nextCursor: "workspace:beta",
      completed: false,
      processed: 2,
      failed: 0,
    });
    expect(String(params?.cursor)).toBe("workspace:aardvark");
    expect(calls.map((call) => call.workspace.toString())).toEqual([
      "workspace:acme",
      "workspace:beta",
    ]);
    expect(calls.every((call) =>
      call.operationKind === "source_expiry"
      && call.actorKind === "system"
      && call.at.toString() === now.toString()
    )).toBeTrue();
  });

  test("isolates one workspace failure and still advances the page", async () => {
    const handler = new SurrealLifecycleBoundarySweepHandler(
      {
        async query() {
          return [[
            { id: new StringRecordId("workspace:acme") },
            { id: new StringRecordId("workspace:beta") },
          ]];
        },
      },
      {
        async refreshWorkspace(input) {
          if (input.workspace.toString() === "workspace:acme") {
            throw new Error("broken source");
          }
          return {};
        },
      },
      { now: () => now },
    );

    await expect(handler.processPage({
      limit: 100,
      fencingToken: 8,
    })).resolves.toMatchObject({
      completed: true,
      processed: 1,
      failed: 1,
    });
  });

  test("rejects a cursor from another table before querying", async () => {
    const handler = new SurrealLifecycleBoundarySweepHandler(
      { async query() {
        throw new Error("must not query");
      } },
      { async refreshWorkspace() {
        return {};
      } },
    );

    await expect(handler.processPage({
      cursor: "quota_plan:plus",
      limit: 10,
      fencingToken: 1,
    })).rejects.toThrow("workspace");
  });
});
