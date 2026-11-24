import { stableSha256 } from "../quota/canonical";

export const TEST_KIT_STALE_MS = 15 * 60_000;
export const TEST_KIT_KEY_PREFIX = "test-kit:";
export const runningTestKitProvisions = new Set<string>();

export function testKitInviteKey(email: string): string {
  return `${TEST_KIT_KEY_PREFIX}${stableSha256(email.trim().toLowerCase()).slice(0, 32)}`;
}
