/**
 * 极简前端路由解析（纯函数，单测覆盖）。
 *
 * App.svelte 沿用 pathname-switch 风格，不引路由库；这里把 pathname 解析成
 * 一个判别联合，popstate/pushState 在容器层驱动。
 *
 * 支持的路由：
 * - `/auth/login`                                  → login
 * - `/auth/callback`                               → callback
 * - `/w/:slug`                                     → workspace（首页 shell）
 * - `/w/:slug/{docs|templates|dashboard|admin|settings|trash}` → workspace 子页面
 * - `/w/:slug/wb/:workbookId`                      → editor（默认 sheet）
 * - `/w/:slug/wb/:workbookId/sheet/:sheetId`       → editor（指定 sheet）
 * - `/form` / `/form-success`                      → 公开表单占位页
 * - 其余                                            → home
 */
export type WorkspacePage =
  | "home"
  | "docs"
  | "templates"
  | "dashboard"
  | "admin"
  | "settings"
  | "trash";

export type Route =
  | { kind: "login" }
  | { kind: "callback" }
  | { kind: "home" }
  | { kind: "form" }
  | { kind: "form-success" }
  | { kind: "workspace"; slug: string; page: WorkspacePage }
  | { kind: "editor"; slug: string; workbookId: string; sheetId: string | null };

const WORKSPACE_PAGES: readonly WorkspacePage[] = [
  "home",
  "docs",
  "templates",
  "dashboard",
  "admin",
  "settings",
  "trash",
];

/** 解析 pathname（不含 query / hash）为 {@link Route}。无法识别的一律落到 home。 */
export function parseRoute(pathname: string): Route {
  if (pathname === "/auth/login") return { kind: "login" };
  if (pathname === "/auth/callback") return { kind: "callback" };
  if (pathname === "/form") return { kind: "form" };
  if (pathname === "/form-success") return { kind: "form-success" };

  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] === "w" && segments[1]) {
    const slug = decodeURIComponent(segments[1]);

    // /w/:slug/wb/:workbookId(/sheet/:sheetId)
    if (segments[2] === "wb" && segments[3]) {
      const workbookId = decodeURIComponent(segments[3]);
      const sheetId =
        segments[4] === "sheet" && segments[5] ? decodeURIComponent(segments[5]) : null;
      return { kind: "editor", slug, workbookId, sheetId };
    }

    // /w/:slug(/:page)——未知子段或 /w/:slug/wb 不完整时退回 workspace home（保 slug）。
    const sub = segments[2] ? decodeURIComponent(segments[2]) : "home";
    const page = (WORKSPACE_PAGES as readonly string[]).includes(sub)
      ? (sub as WorkspacePage)
      : "home";
    return { kind: "workspace", slug, page };
  }

  return { kind: "home" };
}

/** 反向构造编辑器 URL，供导航与 pushState 使用。 */
export function editorPath(slug: string, workbookId: string, sheetId?: string | null): string {
  const base = `/w/${encodeURIComponent(slug)}/wb/${encodeURIComponent(workbookId)}`;
  return sheetId ? `${base}/sheet/${encodeURIComponent(sheetId)}` : base;
}

/** 反向构造 workspace 页面 URL；page 省略或为 home 时只到 `/w/:slug`。 */
export function workspacePath(slug: string, page: WorkspacePage = "home"): string {
  const base = `/w/${encodeURIComponent(slug)}`;
  return page === "home" ? base : `${base}/${page}`;
}
