import { BrowserView, BrowserWindow } from "electrobun/bun";
import { initDb, getDb } from "./db/index";
import { initMastra } from "./ai/index";
import { startOidcLogin } from "./auth/oidc";
import {
  loginToSurrealDB,
  clearSession,
  getPublicAuthState,
  ensureValidSession,
} from "./auth/session";
import type { AppRPC } from "../shared/rpc.types";

async function main() {
  await initDb().catch((err) => {
    console.error("[main] DB init failed:", err);
    process.exit(1);
  });

  try {
    initMastra();
  } catch (err) {
    console.warn("[main] Mastra init warning:", err);
  }

  const rpc = BrowserView.defineRPC<AppRPC>({
    handlers: {
      requests: {
        query: async ({ sql }) => {
          const db = getDb();
          const result = await db.query(sql);
          return result as unknown[];
        },

        getAuthState: async () => {
          return getPublicAuthState();
        },

        startLogin: async () => {
          const db = getDb();
          try {
            const tokens = await startOidcLogin();
            await loginToSurrealDB(db, tokens);
            const state = getPublicAuthState();
            rpc.send("authStateChanged", { state });
            return state;
          } catch (err) {
            console.error("[auth] login failed:", err);
            throw err;
          }
        },

        logout: async () => {
          const db = getDb();
          clearSession();
          // 重新以匿名方式连接（重置 SurrealDB 连接的认证状态）
          await db.invalidate();
          const state = getPublicAuthState();
          rpc.send("authStateChanged", { state });
        },
      },
      messages: {
        log: ({ msg }) => {
          console.log("[webview]", msg);
        },
      },
    },
  });

  const win = new BrowserWindow({
    title: "SurrealCK",
    url: "views://mainview/index.html",
    frame: { width: 1280, height: 800, x: 100, y: 100 },
    rpc,
  });

  win.on("dom-ready", async () => {
    // 推送初始认证状态给 WebView
    const db = getDb();
    await ensureValidSession(db);
    const state = getPublicAuthState();
    rpc.send("authStateChanged", { state });
    console.log("[main] pushed initial auth state:", state);
  });

  console.log("[main] app started");
}

main();
