import { BrowserView, BrowserWindow } from "electrobun/bun";
import { initDb, getDb } from "./db/index";
import { initMastra } from "./ai/index";
import type { AppRPC } from "../shared/rpc.types";

async function main() {
  // DB init — critical, exit on failure
  await initDb().catch((err) => {
    console.error("[main] DB init failed:", err);
    process.exit(1);
  });

  // Mastra init — non-critical
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

  win.on("dom-ready", () => {
    const testRows = [
      { id: "1", name: "Alice", value: "100" },
      { id: "2", name: "Bob", value: "200" },
      { id: "3", name: "Carol", value: "300" },
    ];
    rpc.send("pushRows", { rows: testRows });
    console.log("[main] pushed test rows to WebView");
  });

  console.log("[main] app started");
}

main();
