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

  test("does not log successful query details", async () => {
    const infos: unknown[] = [];
    const warns: unknown[] = [];
    const logger = createSurrealQueryLogger({
      enabled: true,
      source: "test",
      getScope: () => ({ namespace: "main", database: "ws_demo" }),
      logger: { info: (...args) => infos.push(args), warn: (...args) => warns.push(args) },
      now: (() => {
        const values = [100, 112];
        return () => values.shift() ?? 112;
      })(),
    });

    const result = await logger("SELECT *\nFROM user WHERE id = $id", { id: "user:1" }, async () => ["ok"]);

    expect(result).toEqual(["ok"]);
    expect(infos).toEqual([]);
    expect(warns).toEqual([]);
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
          response: { status: "THROWN" },
          error: "boom",
        },
      ],
    ]);
  });

  test("logs a returned error response once and keeps the original result", async () => {
    const warns: unknown[] = [];
    const logger = createSurrealQueryLogger({
      enabled: true,
      source: "test",
      logger: { info: () => undefined, warn: (...args) => warns.push(args) },
      now: (() => {
        const values = [10, 19];
        return () => values.shift() ?? 19;
      })(),
    });
    const response = [
      { status: "OK", time: "1ms", result: [] },
      { status: "ERR", time: "2ms", result: "Table not found: missing_table" },
    ];

    const result = await logger(
      "SELECT * FROM missing_table; SELECT * FROM ok_table;",
      undefined,
      async () => response,
    );

    expect(result).toBe(response);
    expect(warns).toEqual([
      [
        "[surrealdb:query:error]",
        {
          source: "test",
          scope: undefined,
          sql: "SELECT * FROM missing_table; SELECT * FROM ok_table;",
          params: {},
          durationMs: 9,
          response: {
            status: "ERR",
            statements: [
              { index: 0, status: "OK" },
              { index: 1, status: "ERR", error: "Table not found: missing_table" },
            ],
          },
          error: "Table not found: missing_table",
        },
      ],
    ]);
  });

  test("does not treat ordinary row status fields as query response status", async () => {
    const warns: unknown[] = [];
    const logger = createSurrealQueryLogger({
      enabled: true,
      source: "test",
      logger: { info: () => undefined, warn: (...args) => warns.push(args) },
    });

    await logger("SELECT status, result FROM job", undefined, async () => [
      { status: "ERR", result: "user-owned field" },
    ]);

    expect(warns).toEqual([]);
  });
});
