import { signPayload, verifySignature } from "../secure-token";

export { generateToken, hashToken, signPayload, verifySignature } from "../secure-token";

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
