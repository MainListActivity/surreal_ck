import { describe, expect, test } from "bun:test";
import { omitNullishInsertValues } from "./editor";

describe("omitNullishInsertValues", () => {
  test("创建记录时跳过未填写字段，但保留 false 和 0", () => {
    expect(
      omitNullishInsertValues({
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
});
