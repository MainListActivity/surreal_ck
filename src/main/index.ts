import { BrowserView, BrowserWindow } from "electrobun/bun";
import { initDb, getDb } from "./db/index";
import { initMastra } from "./ai/index";
import { startOidcLogin } from "./auth/oidc";
import { ensureSingleInstance } from "./single-instance";
import {
  loginToSurrealDB,
  clearSession,
  getPublicAuthState,
  ensureValidSession,
} from "./auth/session";
import type { AppRPC } from "../shared/rpc.types";

async function main() {
  ensureSingleInstance();

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

        logout: async () => {
          const db = getDb();
          clearSession();
          await db.invalidate();
          const state = getPublicAuthState();
          rpc.send("authStateChanged", { state });
        },
      },
      messages: {
        log: ({ msg }) => {
          console.log("[webview]", msg);
        },

        startLogin: () => {
          const db = getDb();
          startOidcLogin()
            .then((tokens) => loginToSurrealDB(db, tokens))
            .then(() => {
              rpc.send("authStateChanged", { state: getPublicAuthState() });
            })
            .catch((err) => {
              console.error("[auth] login failed:", err);
              rpc.send("authStateChanged", { state: { loggedIn: false, error: String(err) } });
            });
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
