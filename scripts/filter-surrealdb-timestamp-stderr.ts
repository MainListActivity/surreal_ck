import { spawn } from "node:child_process";
import { createNativeStderrFilter } from "../src/main/logging/native-stderr-filter";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

if (args.length === 0) {
  console.error("Usage: bun run scripts/filter-surrealdb-timestamp-stderr.ts -- <command> [...args]");
  process.exit(64);
}

const [command, ...commandArgs] = args;
const child = spawn(command, commandArgs, {
  env: process.env,
  shell: process.platform === "win32",
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout?.on("data", (chunk: Uint8Array) => {
  process.stdout.write(chunk);
});

const stderrFilter = createNativeStderrFilter((chunk) => {
  process.stderr.write(chunk);
});

child.stderr?.on("data", (chunk: Uint8Array) => {
  stderrFilter.write(chunk);
});

child.on("error", (error) => {
  stderrFilter.flush();
  console.error(`[native-stderr-filter] failed to start ${command}:`, error);
  process.exit(127);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("close", (code, signal) => {
  stderrFilter.flush();

  if (typeof code === "number") {
    process.exit(code);
  }

  if (signal === "SIGINT") {
    process.exit(130);
  }

  if (signal === "SIGTERM") {
    process.exit(143);
  }

  process.exit(1);
});
