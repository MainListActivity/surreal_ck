import { describe, expect, test } from "bun:test";
import { normalizeResearchVisitUrl, resolveResearchNavigation } from "./research-url";

describe("research url input", () => {
  test("normalizes standard http/https URLs and bare domains", () => {
    expect(normalizeResearchVisitUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    expect(normalizeResearchVisitUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeResearchVisitUrl("example.com")).toBe("https://example.com/");
    expect(normalizeResearchVisitUrl("www.baidu.com/s?wd=case")).toBe("https://www.baidu.com/s?wd=case");
  });

  test("rejects non-standard domains and non-http protocols for direct navigation", () => {
    expect(normalizeResearchVisitUrl("example")).toBeNull();
    expect(normalizeResearchVisitUrl("http://example")).toBeNull();
    expect(normalizeResearchVisitUrl("file:///tmp/a.html")).toBeNull();
    expect(normalizeResearchVisitUrl("https://example .com")).toBeNull();
  });

  test("uses selected search engine for non-standard URL input", () => {
    expect(resolveResearchNavigation("偷税漏税 案例", "baidu")).toEqual({
      kind: "search",
      url: "https://www.baidu.com/s?wd=%E5%81%B7%E7%A8%8E%E6%BC%8F%E7%A8%8E%20%E6%A1%88%E4%BE%8B",
    });
    expect(resolveResearchNavigation("ftp://example.com", "bing-cn")).toEqual({
      kind: "search",
      url: "https://cn.bing.com/search?q=ftp%3A%2F%2Fexample.com",
    });
  });

  test("resolves standard domain input as direct navigation", () => {
    expect(resolveResearchNavigation("example.com/path?q=1", "baidu")).toEqual({
      kind: "visit",
      url: "https://example.com/path?q=1",
    });
  });
});
