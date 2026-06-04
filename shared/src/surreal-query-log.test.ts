import { describe, expect, test } from "bun:test";
import {
  createSurrealQueryLogger,
  normalizeSurrealQuery,
  shouldLogSurrealQueries,
} from "./surreal-query-log";

describe("surreal query logging", () => {
  test("parses explicit query logging flags with a default fallback", () => {
    expect(shouldLogSurrealQueries(undefined, true)).toBe(true);
    expect(shouldLogSurrealQueries("", false)).toBe(false);
    expect(shouldLogSurrealQueries("true", false)).toBe(true);
    expect(shouldLogSurrealQueries("1", false)).toBe(true);
    expect(shouldLogSurrealQueries("false", true)).toBe(false);
    expect(shouldLogSurrealQueries("0", true)).toBe(false);
    expect(shouldLogSurrealQueries("unexpected", true)).toBe(true);
  });

  test("normalizes multiline SurrealQL into a compact log string", () => {
    expect(normalizeSurrealQuery(" SELECT  *\nFROM user\nWHERE id = $id; ")).toBe(
      "SELECT * FROM user WHERE id = $id;",
    );
  });

  test("logs successful query details with params and duration", async () => {
    const infos: unknown[] = [];
    const logger = createSurrealQueryLogger({
      enabled: true,
      source: "test",
      getScope: () => ({ namespace: "main", database: "ws_demo" }),
      logger: { info: (...args) => infos.push(args), warn: () => undefined },
      now: (() => {
        const values = [100, 112];
        return () => values.shift() ?? 112;
      })(),
    });

    const result = await logger("SELECT *\nFROM user WHERE id = $id", { id: "user:1" }, async () => ["ok"]);

    expect(result).toEqual(["ok"]);
    expect(infos).toEqual([
      [
        "[surrealdb:query]",
        {
          source: "test",
          scope: { namespace: "main", database: "ws_demo" },
          sql: "SELECT * FROM user WHERE id = $id",
          params: { id: "user:1" },
          durationMs: 12,
        },
      ],
    ]);
  });

  test("logs failed query details then rethrows", async () => {
    const warns: unknown[] = [];
    const logger = createSurrealQueryLogger({
      enabled: true,
      source: "test",
      logger: { info: () => undefined, warn: (...args) => warns.push(args) },
      now: (() => {
        const values = [40, 45];
        return () => values.shift() ?? 45;
      })(),
    });

    await expect(
      logger("RETURN $x", { x: 1 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(warns).toEqual([
      [
        "[surrealdb:query:error]",
        {
          source: "test",
          scope: undefined,
          sql: "RETURN $x",
          params: { x: 1 },
          durationMs: 5,
          error: "boom",
        },
      ],
    ]);
  });
});
