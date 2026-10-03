import { describe, expect, test } from "bun:test";
import { getClaimsAttachmentConfig, getClaimsPortalPepper } from "./config";

describe("claims-portal config", () => {
  test("pepper 缺省或过短 → null", () => {
    expect(getClaimsPortalPepper({ CLAIMS_PORTAL_TOKEN_PEPPER: undefined })).toBeNull();
    expect(getClaimsPortalPepper({ CLAIMS_PORTAL_TOKEN_PEPPER: "short" })).toBeNull();
    expect(
      getClaimsPortalPepper({ CLAIMS_PORTAL_TOKEN_PEPPER: "x".repeat(32) }),
    ).toBe("x".repeat(32));
  });

  test("附件五键缺一 → null", () => {
    const full = {
      CLAIMS_ATTACHMENT_ACCOUNT_ID: "acc",
      CLAIMS_ATTACHMENT_ACCESS_KEY_ID: "key",
      CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY: "secret",
      CLAIMS_ATTACHMENT_BUCKET: "bucket",
      CLAIMS_ATTACHMENT_ENDPOINT: "https://r2.example",
    };
    expect(getClaimsAttachmentConfig(full)?.bucket).toBe("bucket");
    expect(getClaimsAttachmentConfig({ ...full, CLAIMS_ATTACHMENT_BUCKET: undefined })).toBeNull();
    expect(getClaimsAttachmentConfig({ ...full, CLAIMS_ATTACHMENT_ENDPOINT: undefined })).toBeNull();
  });
});
