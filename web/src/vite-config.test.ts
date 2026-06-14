import { describe, expect, test } from "bun:test";
import config from "../vite.config";

type ProxyEntry = { target: string; ws?: boolean; changeOrigin?: boolean };

describe("D2-01 vite.config SPA 骨架", () => {
  test("root 指向 web/ 自身（不是 Electrobun 残余的 src/renderer）", () => {
    expect(config.root).toBeUndefined();
  });

  test("base 是 SPA 根路径", () => {
    expect(config.base ?? "/").toBe("/");
  });

  test("读取仓库根 .env，承接根级 VITE_OIDC_* 配置", () => {
    expect(config.envDir).toBe("..");
  });

  test("dev server 把 /api 代理到本地后端 8080", () => {
    const proxy = config.server?.proxy as Record<string, ProxyEntry> | undefined;
    expect(proxy).toBeDefined();
    expect(proxy!["/api"]).toBeDefined();
    expect(proxy!["/api"].target).toBe("http://localhost:8080");
    expect(proxy!["/api"].changeOrigin).toBe(true);
  });

  test("dev server 也通过 /api 代理 Mastra chat stream 的 WebSocket upgrade", () => {
    const proxy = config.server?.proxy as Record<string, ProxyEntry> | undefined;
    expect(proxy!["/api"].ws).toBe(true);
  });

  test("dev server 把 /ws 代理到本地后端 8080 并开启 ws", () => {
    const proxy = config.server?.proxy as Record<string, ProxyEntry> | undefined;
    expect(proxy!["/ws"]).toBeDefined();
    expect(proxy!["/ws"].target).toBe("ws://localhost:8080");
    expect(proxy!["/ws"].ws).toBe(true);
  });

  test("build.outDir 落在 web/dist", () => {
    expect(config.build?.outDir ?? "dist").toBe("dist");
  });

  test("dev dependency scan 只从新 SPA 入口开始，避免扫到 web/legacy", () => {
    expect(config.optimizeDeps?.entries).toEqual(["index.html"]);
  });
});
