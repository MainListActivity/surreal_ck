import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_DIR = join(tmpdir(), "surreal-ck.lock");
const PID_FILE = join(LOCK_DIR, "pid");

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readLockPid(): number | null {
  try {
    const value = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(value);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removeLock(): void {
  if (existsSync(LOCK_DIR)) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

export function ensureSingleInstance(): void {
  try {
    mkdirSync(LOCK_DIR);
    writeFileSync(PID_FILE, `${process.pid}\n`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw err;
    }

    const existingPid = readLockPid();
    if (existingPid && isProcessRunning(existingPid)) {
      console.warn(`[main] app already running with PID ${existingPid}; exiting duplicate instance`);
      process.exit(0);
    }

    removeLock();
    mkdirSync(LOCK_DIR);
    writeFileSync(PID_FILE, `${process.pid}\n`);
  }

  process.once("exit", removeLock);
  process.once("SIGINT", () => {
    removeLock();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    removeLock();
    process.exit(143);
  });
}
