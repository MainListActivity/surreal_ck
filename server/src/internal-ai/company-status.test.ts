import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { COMPANY_PROOF_ISSUER, COMPANY_PROOF_AUDIENCE } from "@surreal-ck/shared";
import { verifyCompanyStatus } from "./company-status";
const pair = generateKeyPairSync("ed25519");
const anchor = { alg: "EdDSA", kid: "test-status-key", jwk: pair.publicKey.export({ format: "jwk" }) };
const now = Date.now(), seconds = Math.floor(now / 1000), nonce = "A".repeat(32);
const expected = { jti: "synthetic-status-jti", exp: seconds + 300, approval: null };
const base = { iss: COMPANY_PROOF_ISSUER, aud: COMPANY_PROOF_AUDIENCE, jti: expected.jti, valid: true, version: 1, approvalVersion: null,
  checkedAt: seconds, iat: seconds, exp: seconds + 60, nonce };
function token(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const message = `${encode({ alg: "EdDSA", kid: anchor.kid, typ: "sck-internal-ai-status+jwt", ...header })}.${encode({ ...base, ...over })}`;
  return `${message}.${sign(null, Buffer.from(message), pair.privateKey).toString("base64url")}`;
}
test("current signed status accepts only bound jti, nonce, approval and <=60s window", () => {
  expect(() => verifyCompanyStatus(token(), expected, nonce, now, anchor)).not.toThrow();
  for (const over of [{ valid: false }, { nonce: "B".repeat(32) }, { jti: "other" }, { approvalVersion: 2 }, { exp: seconds },
    { exp: seconds + 61 }, { checkedAt: seconds + 1 }, { checkedAt: seconds - 60 }, { iat: seconds + 1 }, { unknown: true }, { aud: "other" }]) {
    expect(() => verifyCompanyStatus(token(over), expected, nonce, now, anchor)).toThrow(/当前状态/);
  }
  expect(() => verifyCompanyStatus(token(), { ...expected, exp: seconds }, nonce, now, anchor)).toThrow();
});
test("status rejects wrong type, alg, key, signature and malformed token", () => {
  for (const header of [{ typ: "sck-internal-ai-proof+jwt" }, { alg: "HS256" }, { kid: "other" }]) {
    expect(() => verifyCompanyStatus(token({}, header), expected, nonce, now, anchor)).toThrow();
  }
  const jwt = token();
  const [h, b] = jwt.split(".");
  expect(() => verifyCompanyStatus(`${h}.${b}.AAAA`, expected, nonce, now, anchor)).toThrow();
  expect(() => verifyCompanyStatus("invalid", expected, nonce, now, anchor)).toThrow();
});
