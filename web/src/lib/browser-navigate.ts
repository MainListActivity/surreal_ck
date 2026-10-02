/**
 * 浏览器内程序化导航：pushState 不会触发 popstate，而 App 的路由同步挂在
 * popstate 监听上（syncRoute + ensureWorkspace）。push 后必须补发事件，
 * 路由才立刻跟上新 URL——缺失时路由停在旧 slug+page：office/editor 继续
 * 渲染旧 workspace 的库快照、工作区内导航链接用旧 slug 跳回（VO04 QA
 * 生产实测阻断）。依赖注入以便单测。
 */
export function createBrowserNavigate(win: {
  history: Pick<History, "pushState">;
  dispatchEvent: (event: Event) => boolean;
}): (url: string) => void {
  return (url) => {
    win.history.pushState({}, "", url);
    win.dispatchEvent(new Event("popstate"));
  };
}
