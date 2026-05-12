import { describe, expect, test } from "bun:test";
import { assertSafeChangefeedCursor, showChangesQuery } from "./changefeed";

describe("changefeed 查询", () => {
  test("SHOW CHANGES 的 cursor 以内联 versionstamp 字面量生成", () => {
    const query = showChangesQuery("workspace", "65536");

    expect(query.query).toBe("SHOW CHANGES FOR TABLE workspace SINCE 65536 LIMIT 100");
    expect(query.bindings).toEqual({});
  });

  test("拒绝非数字 versionstamp，避免拼入不安全 cursor", () => {
    expect(() => assertSafeChangefeedCursor("vs1")).toThrow("[sync] unsafe changefeed cursor: vs1");
    expect(() => assertSafeChangefeedCursor("0; DELETE workspace")).toThrow();
  });
});
