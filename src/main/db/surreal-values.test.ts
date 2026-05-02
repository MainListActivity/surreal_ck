import { describe, expect, test } from "bun:test";
import {
  mapNullToSurrealNone,
  mapNullsToSurrealNone,
  omitNullishSurrealFields,
} from "./surreal-values";

describe("surreal-values", () => {
  test("omitNullishSurrealFields 用于 create/content，跳过 null 和 undefined", () => {
    expect(
      omitNullishSurrealFields({
        title: "合同 A",
        note: null,
        owner: undefined,
        enabled: false,
        count: 0,
      }),
    ).toEqual({
      title: "合同 A",
      enabled: false,
      count: 0,
    });
  });

  test("mapNullToSurrealNone 用于 set，null 转 undefined", () => {
    expect(mapNullToSurrealNone(null)).toBeUndefined();
    expect(mapNullToSurrealNone("x")).toBe("x");
  });

  test("mapNullsToSurrealNone 用于 merge，批量把 null 转 undefined", () => {
    expect(
      mapNullsToSurrealNone({
        note: null,
        title: "合同 A",
        enabled: false,
      }),
    ).toEqual({
      note: undefined,
      title: "合同 A",
      enabled: false,
    });
  });
});
