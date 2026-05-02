import { BrowserView, BrowserWindow } from "electrobun/bun";
import { initEngine, tryRestoreSession } from "./db/index";
import { initMastra } from "./ai/index";
import { ensureSingleInstance } from "./single-instance";
import { activateSession, loginToSurrealDB, getPublicAuthState } from "./auth/session";
import { setOfflineMode } from "./services/context";
import { decodeTokenClaims, bootstrapLocalIdentity } from "./services/identity";
import { createRpcHandlers } from "./rpc/handlers";
import { installApplicationMenu } from "./app-menu";
import type { AppRPC } from "../shared/rpc.types";

async function main() {
  ensureSingleInstance();
  installApplicationMenu();

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
    handlers: createRpcHandlers((event, payload) => rpc.send(event, payload)),
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
      if (result.tokens) {
        loginToSurrealDB(result.tokens);
      } else {
        activateSession(result.expiresAt);
      }
      // 所有恢复路径都执行 identity bootstrap（幂等，保证 user/workspace 存在）
      try {
        const claims = decodeTokenClaims(result.accessToken);
        await bootstrapLocalIdentity(claims);
      } catch (err) {
        console.warn("[main] identity bootstrap failed after restore:", err);
      }
    }

    if (result.status === "offline") {
      setOfflineMode(true);
    }

    const state = getPublicAuthState(result.status === "offline" ? { offlineMode: true } : undefined);
    rpc.send("authStateChanged", { state });
    console.log("[main] pushed initial auth state:", result.status);
  });

  console.log("[main] app started");
}

main();
