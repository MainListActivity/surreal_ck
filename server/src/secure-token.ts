import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 默认 256 位随机值，编码为不带填充的 URL 安全 base64。 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** SHA-256(token || pepper) 的十六进制摘要。 */
export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(token, "utf8").update(pepper, "utf8").digest("hex");
}

export function signPayload(payload: string, pepper: string): string {
  return createHmac("sha256", pepper).update(payload, "utf8").digest("base64url");
}

export function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifySignature(payload: string, signature: string, pepper: string): boolean {
  return safeTextEqual(signPayload(payload, pepper), signature);
}
