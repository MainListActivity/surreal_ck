import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "surreal-ck.ai";
const KEYCHAIN_REF_PREFIX = `keychain:${KEYCHAIN_SERVICE}/`;

export function createKeychainSecretRef(): string {
  return `${KEYCHAIN_REF_PREFIX}${randomUUID()}`;
}

export function isManagedKeychainSecretRef(ref: string | undefined): ref is string {
  return !!ref && ref.startsWith(KEYCHAIN_REF_PREFIX);
}

export function writeSecret(ref: string, secret: string): void {
  const account = accountFromRef(ref);
  runSecurity(["add-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w", secret, "-U"]);
}

export function deleteSecret(ref: string | undefined): void {
  if (!isManagedKeychainSecretRef(ref)) return;
  const account = accountFromRef(ref);
  const result = spawnSync("security", ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], {
    encoding: "utf8",
  });
  if (result.status !== 0 && !String(result.stderr).includes("could not be found")) {
    throw new Error(`[secret-store] failed to delete secret: ${result.stderr || result.stdout}`);
  }
}

function accountFromRef(ref: string): string {
  if (!isManagedKeychainSecretRef(ref)) {
    throw new Error("[secret-store] unsupported secret_ref");
  }
  const account = ref.slice(KEYCHAIN_REF_PREFIX.length);
  if (!account) throw new Error("[secret-store] invalid secret_ref");
  return account;
}

function runSecurity(args: string[]): void {
  if (process.platform !== "darwin") {
    throw new Error("[secret-store] OS credential storage is only implemented for macOS Keychain");
  }
  const result = spawnSync("security", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`[secret-store] security command failed: ${result.stderr || result.stdout}`);
  }
}
