import { describe, expect, test } from "bun:test";
import { toSurrealNone } from "./surreal-values";

describe("toSurrealNone", () => {
  test("maps nullable optional values to undefined so surrealdb-js sends NONE", () => {
    expect(toSurrealNone(null)).toBeUndefined();
    expect(toSurrealNone(undefined)).toBeUndefined();
    expect(toSurrealNone("active")).toBe("active");
    expect(toSurrealNone(0)).toBe(0);
  });
});
