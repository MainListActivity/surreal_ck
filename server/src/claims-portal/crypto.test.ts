import { describe, expect, test } from "bun:test";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  generateToken,
  hashToken,
} from "./crypto";

describe("claims-portal crypto", () => {
  test("generateToken 为 URL-safe 且足够长", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(token);
  });

  test("hashToken 对相同输入确定，明文不反向出现", () => {
    const pepper = "test-claims-portal-pepper-32bytes-min!!";
    const token = "plain-token-value";
    const hash = hashToken(token, pepper);
    expect(hash).toBe(hashToken(token, pepper));
    expect(hash).not.toBe(hashToken(token, pepper + "x"));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("会话 cookie 签名往返，篡改失败", () => {
    const pepper = "test-claims-portal-pepper-32bytes-min!!";
    const raw = encodeSessionCookie({
      slug: "case-a",
      tokenId: "claim_access_token:t1",
      rosterId: "creditor_roster:r1",
      exp: Date.now() + 60_000,
      pepper,
    });
    const decoded = decodeSessionCookie(raw, pepper);
    expect(decoded?.slug).toBe("case-a");
    expect(decoded?.tokenId).toBe("claim_access_token:t1");

    const tampered = `${raw.slice(0, -2)}aa`;
    expect(decodeSessionCookie(tampered, pepper)).toBeNull();
    expect(decodeSessionCookie(raw, pepper + "nope")).toBeNull();
  });
});
