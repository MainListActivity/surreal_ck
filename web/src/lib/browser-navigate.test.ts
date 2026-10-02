import { describe, expect, test } from "bun:test";
import { createBrowserNavigate } from "./browser-navigate";

function fakeWindow() {
  const pushed: Array<{ state: unknown; url: string }> = [];
  const dispatched: string[] = [];
  return {
    pushed,
    dispatched,
    win: {
      history: {
        pushState(state: unknown, _unused: string, url: string) {
          pushed.push({ state, url });
        },
      },
      dispatchEvent(event: Event) {
        dispatched.push(event.type);
        return true;
      },
    },
  };
}

describe("createBrowserNavigate — 工作区切换等程序化导航", () => {
  test("pushState 写新 URL 并补发 popstate，路由同步监听能收到（b09c87b1 回归）", () => {
    const { win, pushed, dispatched } = fakeWindow();
    const navigate = createBrowserNavigate(win);

    navigate("/w/qa-ver05-gate");

    expect(pushed).toEqual([{ state: {}, url: "/w/qa-ver05-gate" }]);
    expect(dispatched).toEqual(["popstate"]);
  });

  test("每次调用都发一次事件：连续导航不会丢同步", () => {
    const { win, dispatched } = fakeWindow();
    const navigate = createBrowserNavigate(win);

    navigate("/w/a");
    navigate("/w/b/office");

    expect(dispatched).toEqual(["popstate", "popstate"]);
  });
});
