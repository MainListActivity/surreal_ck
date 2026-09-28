import { describe, expect, test } from "bun:test";
import { exchangeContentReader, planContentReaderExchange, type ContentReaderEntitlement, type ContentReaderTarget } from "./reader-exchange";

const NOW = 1_780_000_000;

const entitlement: ContentReaderEntitlement = {
  revision: 4,
  digest: "sha256:abc",
  resolverVersion: "product-entitlement-v1",
  effectiveUntilSeconds: null,
  collections: ["core"],
  contentActions: ["browse", "read"],
  aiActions: [],
};

const content: ContentReaderTarget = {
  versionId: "content_version:v",
  itemId: "content_item:i",
  licenseId: "source_license_revision:l",
  sourceActive: true,
  publicationStatus: "published",
  collectionKeys: ["core"],
  licenseFromSeconds: NOW - 10,
  licenseUntilSeconds: null,
  licenseActions: ["browse", "read", "cite"],
};

const base = {
  subject: "human",
  workspaceDb: "ws_alpha",
  workspaceActive: true,
  membership: "active" as const,
  activeSubjects: ["human", "admin"],
  subjectExpiresAtSeconds: NOW + 5_000,
  nowSeconds: NOW,
  subjectIsContentReader: false,
  database: "platform_content",
  namespace: "main",
  entitlement,
  content,
};

describe("content reader exchange plan", () => {
  test("caps the lease at 900 seconds and keeps every active subject", () => {
    const planned = planContentReaderExchange({ ...base, body: { contentPublicId: "law-1" } });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.leaseEndSeconds).toBe(NOW + 900);
    expect(planned.plan.idp).toEqual({
      workspaceId: "ws_alpha",
      entitlementRevision: "4",
      leaseEndSeconds: NOW + 900,
      database: "platform_content",
    });
    expect(planned.plan.write.allowedSubjects).toEqual(["human", "admin"]);
    expect(planned.plan.success.digest).toBe("sha256:abc");
  });

  test("rejects caller-supplied authority, removed members, and publish-only licenses", () => {
    expect(planContentReaderExchange({ ...base, body: { contentPublicId: "law-1", entitlementRevision: "9" } }).ok).toBe(false);
    expect(planContentReaderExchange({ ...base, membership: "removed", body: { contentPublicId: "law-1" } })).toEqual({ ok: false, error: "member_removed" });
    expect(planContentReaderExchange({
      ...base,
      body: { contentPublicId: "law-1" },
      content: { ...content, licenseActions: ["publish"] },
    })).toEqual({ ok: false, error: "action_denied" });
    expect(planContentReaderExchange({
      ...base,
      body: { contentPublicId: "law-1" },
      content: { ...content, publicationStatus: "withdrawn" },
    })).toEqual({ ok: false, error: "content_withdrawn" });
  });
});

describe("content reader exchange execution", () => {
  test("writes the projection only after the IdP accepts, and does not treat 900 as unbounded", async () => {
    const writes: unknown[] = [];
    const result = await exchangeContentReader({
      ...base,
      body: { contentPublicId: "law-1" },
      subjectToken: "workspace-token",
      exchangeIdp: async () => ({ accessToken: "content-token", expiresInSeconds: 120 }),
      writeProjection: async (write) => { writes.push(write); },
    });
    expect(result).toMatchObject({ tokenType: "Bearer", expiresInSeconds: 120, contentPublicId: "law-1" });
    expect(writes).toHaveLength(1);
    const rejected = await exchangeContentReader({
      ...base,
      body: { contentPublicId: "law-1" },
      subjectToken: "workspace-token",
      exchangeIdp: async () => ({ error: "invalid_scope" }),
      writeProjection: async () => { throw new Error("must not write"); },
    });
    expect(rejected).toEqual({ ok: false, error: "idp_rejected", idpError: "invalid_scope" });
  });
});
