import { createApp } from "./app";
import { env } from "./env";
import { closeRootConnection, initRootConnection } from "./db/root-connection";

await initRootConnection();

const app = createApp();
const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  fetch: app.fetch,
});

console.info("[server] listening", {
  host: env.HOST,
  port: env.PORT,
  env: env.NODE_ENV,
});

async function shutdown(signal: string): Promise<void> {
  console.info("[server] shutting down", { signal });
  server.stop();
  await closeRootConnection();
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
