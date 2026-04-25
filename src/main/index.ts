import { BrowserView, BrowserWindow } from "electrobun/bun";
import { initEngine, initUserDb, tryRestoreSession, closeUserDb, getLocalDb, type RestoreResult } from "./db/index";
import { initMastra } from "./ai/index";
import { startOidcLogin } from "./auth/oidc";
import { ensureSingleInstance } from "./single-instance";
import {
  loginToSurrealDB,
  clearSession,
  getPublicAuthState,
} from "./auth/session";
import type { AppRPC } from "../shared/rpc.types";

// JWT payload 解码（用于提取 sub）
function decodeJwtSub(token: string): string {
  const part = token.split(".")[1];
  const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!payload.sub) throw new Error("JWT missing sub claim");
  return payload.sub as string;
}

async function main() {
  ensureSingleInstance();

  // 只初始化 embedded engine，不依赖登录状态
  await initEngine().catch((err) => {
    console.error("[main] engine init failed:", err);
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
          // getLocalDb() 在未登录时 throw，Electrobun 将 Error 传回 WebView
          const db = getLocalDb();
          const result = await db.query(sql);
          return result as unknown[];
        },

        getAuthState: async () => {
          return getPublicAuthState();
        },

        logout: async () => {
          clearSession();
          await closeUserDb();
          const state = getPublicAuthState();
          rpc.send("authStateChanged", { state });
        },
      },
      messages: {
        log: ({ msg }) => {
          console.log("[webview]", msg);
        },

        startLogin: () => {
          startOidcLogin()
            .then(async (tokens) => {
              const sub = decodeJwtSub(tokens.access_token);
              await initUserDb(sub, tokens);
              loginToSurrealDB(tokens);
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
    const result = await tryRestoreSession();

    if (result.status === "restored") {
      loginToSurrealDB(result.tokens);
    }

    const state =
      result.status === "offline"
        ? getPublicAuthState({ offlineMode: true })
        : getPublicAuthState();

    rpc.send("authStateChanged", { state });
    console.log("[main] pushed initial auth state:", result.status);
  });

  console.log("[main] app started");
}

main();
