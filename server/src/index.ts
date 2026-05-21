import { startServer } from "./startup";

const running = await startServer();

process.on("SIGTERM", () => {
  void running.shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void running.shutdown("SIGINT");
});
