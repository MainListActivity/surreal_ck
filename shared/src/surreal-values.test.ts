import { describe, expect, test } from "bun:test";
import {
  mapNullToSurrealNone,
  mapNullsToSurrealNone,
  omitNullishSurrealFields,
} from "./surreal-values";

describe("omitNullishSurrealFields", () => {
  test("丢弃 null 与 undefined，保留其余（含 falsy 的 0/''/false）", () => {
    expect(
      omitNullishSurrealFields({ a: 1, b: null, c: undefined, d: 0, e: "", f: false }),
    ).toEqual({ a: 1, d: 0, e: "", f: false });
  });

  test("空对象与全空字段返回空对象", () => {
    expect(omitNullishSurrealFields({})).toEqual({});
    expect(omitNullishSurrealFields({ a: null, b: undefined })).toEqual({});
  });
});

describe("mapNullsToSurrealNone", () => {
  test("null → undefined，其余原样且字段都保留", () => {
    expect(mapNullsToSurrealNone({ a: 1, b: null })).toEqual({ a: 1, b: undefined });
  });

  test("undefined 保持 undefined，falsy 非 null 值不动", () => {
    expect(mapNullsToSurrealNone({ a: 0, b: "", c: false, d: undefined })).toEqual({
      a: 0,
      b: "",
      c: false,
      d: undefined,
    });
  });
});

describe("mapNullToSurrealNone", () => {
  test("null → undefined，其余原样", () => {
    expect(mapNullToSurrealNone(null)).toBeUndefined();
    expect(mapNullToSurrealNone(0)).toBe(0);
    expect(mapNullToSurrealNone("x")).toBe("x");
    expect(mapNullToSurrealNone(undefined)).toBeUndefined();
  });
});
