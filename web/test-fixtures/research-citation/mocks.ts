import type { ContentPage } from "../../src/lib/content-reader";
export const body = "前言第一条 设备须定期检查。";
export const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const getCurrentWorkspace = () => ({ slug: "fixture", dbName: "ws_fixture" });
export const createBrowserContentReader = () => ({
  open: async () => ({ ok: true as const, page: { versionId: "content_version:a", publicId: "a-v1", title: "测试内容 · 固定版本",
    revision: 1, versionLabel: "v1", sourceUrl: "https://example.invalid", sourceForm: "fixture", publishedAt: null,
    bodyText: body, canCite: false, articles: [], authorizedUntilSeconds: Math.floor(Date.now() / 1000) + 300 } satisfies ContentPage }),
  close: async () => {},
});
