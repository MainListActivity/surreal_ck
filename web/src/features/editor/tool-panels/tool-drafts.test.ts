import { describe, expect, test } from "bun:test";
import {
  cleanFilterDrafts,
  cleanSortDrafts,
  filterValueKind,
  type FilterDraft,
  type SortDraft,
} from "./tool-drafts";

describe("filterValueKind", () => {
  test("is_null / is_not_null 不需要值", () => {
    expect(filterValueKind("is_null")).toBe("none");
    expect(filterValueKind("is_not_null")).toBe("none");
  });

  test("in 需要数组", () => {
    expect(filterValueKind("in")).toBe("array");
  });

  test("其余为标量", () => {
    expect(filterValueKind("eq")).toBe("scalar");
    expect(filterValueKind("contains")).toBe("scalar");
  });
});

describe("cleanFilterDrafts", () => {
  test("剥离本地 id 并保留命中列的条件", () => {
    const drafts: FilterDraft[] = [
      { id: 1, key: "name", op: "eq", value: "张三" },
      { id: 2, key: "age", op: "gte", value: 18 },
    ];
    const result = cleanFilterDrafts(drafts, ["name", "age"]);
    expect(result).toEqual([
      { key: "name", op: "eq", value: "张三" },
      { key: "age", op: "gte", value: 18 },
    ]);
    expect(result.every((c) => !("id" in c))).toBe(true);
  });

  test("丢弃 key 不在当前列集合的脏条件", () => {
    const drafts: FilterDraft[] = [
      { id: 1, key: "name", op: "eq", value: "x" },
      { id: 2, key: "removed_col", op: "eq", value: "y" },
    ];
    expect(cleanFilterDrafts(drafts, ["name"])).toEqual([{ key: "name", op: "eq", value: "x" }]);
  });

  test("in 的字符串值按逗号 / 换行拆成数组并去空白", () => {
    const drafts: FilterDraft[] = [{ id: 1, key: "tag", op: "in", value: " a, b\n c , " }];
    expect(cleanFilterDrafts(drafts, ["tag"])).toEqual([
      { key: "tag", op: "in", value: ["a", "b", "c"] },
    ]);
  });

  test("in 已是数组时原样保留", () => {
    const drafts: FilterDraft[] = [{ id: 1, key: "tag", op: "in", value: ["a", "b"] }];
    expect(cleanFilterDrafts(drafts, ["tag"])).toEqual([{ key: "tag", op: "in", value: ["a", "b"] }]);
  });
});

describe("cleanSortDrafts", () => {
  test("剥离 id 并保留顺序（即排序优先级）", () => {
    const drafts: SortDraft[] = [
      { id: 5, key: "age", direction: "desc" },
      { id: 2, key: "name", direction: "asc" },
    ];
    expect(cleanSortDrafts(drafts, ["name", "age"])).toEqual([
      { key: "age", direction: "desc" },
      { key: "name", direction: "asc" },
    ]);
  });

  test("丢弃已删除列的排序", () => {
    const drafts: SortDraft[] = [
      { id: 1, key: "name", direction: "asc" },
      { id: 2, key: "gone", direction: "desc" },
    ];
    expect(cleanSortDrafts(drafts, ["name"])).toEqual([{ key: "name", direction: "asc" }]);
  });
});
