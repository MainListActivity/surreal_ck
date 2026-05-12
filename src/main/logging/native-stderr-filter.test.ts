import { describe, expect, test } from "bun:test";
import { createNativeStderrFilter, filterNativeStderrText } from "./native-stderr-filter";

const timestampDbgBlock = `[/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/surrealdb-core-3.0.2/src/kvs/timestamp.rs:272:18] self.0.to_be_bytes() = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
]
`;

describe("native stderr filter", () => {
  test("removes SurrealDB timestamp dbg blocks", () => {
    expect(filterNativeStderrText(`before\n${timestampDbgBlock}after\n`)).toBe("before\nafter\n");
  });

  test("keeps unrelated stderr lines", () => {
    const unrelated = "[/tmp/other.rs:1:2] value = [\n";

    expect(filterNativeStderrText(unrelated)).toBe(unrelated);
  });

  test("handles timestamp dbg blocks split across chunks", () => {
    const output: string[] = [];
    const filter = createNativeStderrFilter((chunk) => output.push(chunk));

    filter.write(`before\n${timestampDbgBlock.slice(0, 120)}`);
    filter.write(timestampDbgBlock.slice(120));
    filter.write("after\n");
    filter.flush();

    expect(output.join("")).toBe("before\nafter\n");
  });
});
