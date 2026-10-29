import { describe, expect, test } from "bun:test";

const root = import.meta.dir;
const read = (path: string) => Bun.file(`${root}/${path}`).text();

describe("空数据表引导", () => {
  test("空表时 GridView 指向「导入文件」与「从模板创建」两条路", async () => {
    const grid = await read("GridView.svelte");
    expect(grid).toContain("gridSource.length === 0");
    expect(grid).toContain("导入文件");
    expect(grid).toContain("从模板创建");
    expect(grid).toContain("包含样例数据");
  });
});
