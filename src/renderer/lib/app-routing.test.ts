import { describe, expect, test } from "bun:test";
import type { RouteState, ScreenId } from "./types";
import {
  RESEARCH_WINDOW_PARAMS_KEY,
  STORED_ROUTE_KEY,
  persistRoute,
  readInitialRoute,
  readResearchWindowRoute,
  shouldShowLoginGate,
} from "./app-routing";

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const validScreens = new Set<ScreenId>(["home", "editor", "research"]);

describe("app routing", () => {
  test("研究窗口参数优先生成 research 路由并消费 storage key", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORED_ROUTE_KEY, JSON.stringify({ screen: "home" } satisfies RouteState));
    storage.setItem(RESEARCH_WINDOW_PARAMS_KEY, JSON.stringify({
      mode: "research",
      sessionId: "research_session:s1",
      resourceType: "web_article",
      initialUrl: "https://example.com",
    }));

    expect(readResearchWindowRoute(storage)).toEqual({
      screen: "research",
      researchSessionId: "research_session:s1",
      resourceType: "web_article",
      initialUrl: "https://example.com",
    });
    expect(storage.getItem(RESEARCH_WINDOW_PARAMS_KEY)).toBeNull();
  });

  test("readInitialRoute 优先打开研究窗口而不是普通持久路由", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORED_ROUTE_KEY, JSON.stringify({ screen: "editor", workbookId: "workbook:old" } satisfies RouteState));
    storage.setItem(RESEARCH_WINDOW_PARAMS_KEY, JSON.stringify({ mode: "research", resourceType: "generic_note" }));

    expect(readInitialRoute(storage, validScreens)).toEqual({
      screen: "research",
      resourceType: "generic_note",
      initialUrl: undefined,
      researchSessionId: undefined,
    });
  });

  test("research 路由不被登录页首屏拦截", () => {
    expect(shouldShowLoginGate({ screen: "research" }, { loggedIn: false })).toBe(false);
    expect(shouldShowLoginGate({ screen: "home" }, { loggedIn: false })).toBe(true);
    expect(shouldShowLoginGate({ screen: "home" }, { loggedIn: true })).toBe(false);
  });

  test("research 路由不会覆盖普通窗口持久路由", () => {
    const storage = new MemoryStorage();
    persistRoute(storage, { screen: "research", resourceType: "generic_note" });
    expect(storage.getItem(STORED_ROUTE_KEY)).toBeNull();

    persistRoute(storage, { screen: "home" });
    expect(storage.getItem(STORED_ROUTE_KEY)).toBe(JSON.stringify({ screen: "home" }));
  });
});
