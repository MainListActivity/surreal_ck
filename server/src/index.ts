import { startServer } from "./startup";

const running = await startServer();

let stopping = false;

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  running.shutdown(signal).then(
    () => process.exit(0),
    (cause: unknown) => {
      console.error("[server] shutdown failed", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
      process.exit(1);
    },
  );
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
