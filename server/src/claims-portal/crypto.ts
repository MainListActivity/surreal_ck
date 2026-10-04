import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** ≥256 bit 随机，URL-safe base64（去 padding）。 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** SHA-256(token || pepper) 的 hex；库中只存哈希。 */
export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(token, "utf8").update(pepper, "utf8").digest("hex");
}

export function signPayload(payload: string, pepper: string): string {
  return createHmac("sha256", pepper).update(payload, "utf8").digest("base64url");
}

export function verifySignature(payload: string, signature: string, pepper: string): boolean {
  const expected = signPayload(payload, pepper);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function encodeSessionCookie(parts: {
  slug: string;
  tokenId: string;
  rosterId: string;
  exp: number;
  pepper: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      slug: parts.slug,
      tokenId: parts.tokenId,
      rosterId: parts.rosterId,
      exp: parts.exp,
    }),
    "utf8",
  ).toString("base64url");
  const sig = signPayload(payload, parts.pepper);
  return `${payload}.${sig}`;
}

export function decodeSessionCookie(
  raw: string,
  pepper: string,
): { slug: string; tokenId: string; rosterId: string; exp: number } | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!verifySignature(payload, sig, pepper)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      slug?: unknown;
      tokenId?: unknown;
      rosterId?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.slug !== "string"
      || typeof parsed.tokenId !== "string"
      || typeof parsed.rosterId !== "string"
      || typeof parsed.exp !== "number"
    ) {
      return null;
    }
    return {
      slug: parsed.slug,
      tokenId: parsed.tokenId,
      rosterId: parsed.rosterId,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
