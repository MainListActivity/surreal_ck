import { describe, expect, test } from "bun:test";
import {
  CONTENT_READER_BOUND_SECONDS,
  CLIENT_AUTHORITY_FIELDS,
  contentReaderExchangeRequestSchema,
  contentReaderFieldAllowed,
  contentReaderLeaseEnd,
  contentReaderPermissions,
  formatEntitlementRevision,
  remainingContentReaderCloseSeconds,
} from "./content-reader";

const NOW = 1_780_000_000;

describe("content reader lease", () => {
  test("caps an open-ended entitlement at 900 seconds", () => {
    const result = contentReaderLeaseEnd({
      nowSeconds: NOW,
      subjectExpiresAtSeconds: NOW + 86_400,
      entitlementEffectiveUntilSeconds: null,
      licenseEffectiveUntilSeconds: null,
    });
    expect(result).toEqual({ ok: true, leaseEndSeconds: NOW + CONTENT_READER_BOUND_SECONDS });
  });

  test("does not outlive entitlement, license, or the subject token", () => {
    expect(contentReaderLeaseEnd({
      nowSeconds: NOW,
      subjectExpiresAtSeconds: NOW + 5_000,
      entitlementEffectiveUntilSeconds: NOW + 300,
      licenseEffectiveUntilSeconds: NOW + 120,
    })).toEqual({ ok: true, leaseEndSeconds: NOW + 120 });
    expect(contentReaderLeaseEnd({
      nowSeconds: NOW,
      subjectExpiresAtSeconds: NOW + 60,
      entitlementEffectiveUntilSeconds: null,
      licenseEffectiveUntilSeconds: null,
    })).toEqual({ ok: true, leaseEndSeconds: NOW + 60 });
  });

  test("rejects an already expired entitlement or license", () => {
    expect(contentReaderLeaseEnd({
      nowSeconds: NOW,
      subjectExpiresAtSeconds: NOW + 100,
      entitlementEffectiveUntilSeconds: NOW,
      licenseEffectiveUntilSeconds: null,
    }).ok).toBe(false);
    expect(contentReaderLeaseEnd({
      nowSeconds: NOW,
      subjectExpiresAtSeconds: NOW + 100,
      entitlementEffectiveUntilSeconds: null,
      licenseEffectiveUntilSeconds: NOW - 1,
    })).toEqual({ ok: false, error: "lease_exceeds_validity" });
  });
});

describe("content reader revocation bound", () => {
  test("closes on the earliest of token, session, and projection confirmation", () => {
    expect(remainingContentReaderCloseSeconds({
      nowSeconds: NOW,
      tokenExpiresAtSeconds: NOW + 900,
      sessionExpiresAtSeconds: NOW + 400,
      projectionConfirmedUntilSeconds: NOW + 200,
    })).toBe(200);
    expect(remainingContentReaderCloseSeconds({
      nowSeconds: NOW,
      tokenExpiresAtSeconds: NOW + 900,
      sessionExpiresAtSeconds: NOW + 900,
      projectionConfirmedUntilSeconds: NOW + 900,
    })).toBe(900);
    expect(remainingContentReaderCloseSeconds({
      nowSeconds: NOW,
      tokenExpiresAtSeconds: NOW - 1,
      sessionExpiresAtSeconds: NOW + 900,
      projectionConfirmedUntilSeconds: NOW + 900,
    })).toBe(0);
  });
});

describe("content reader permission matrix", () => {
  test("metadata-only cannot read body, excerpt, or article text", () => {
    const parsed = contentReaderPermissions({ contentActions: ["browse", "search"], aiActions: [] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.permissions).toEqual({
      search: true,
      read: false,
      cite: false,
      export: false,
      aiUse: false,
      metadataOnly: true,
    });
    expect(contentReaderFieldAllowed("metadata", parsed.permissions)).toBe(true);
    expect(contentReaderFieldAllowed("body", parsed.permissions)).toBe(false);
    expect(contentReaderFieldAllowed("excerpt", parsed.permissions)).toBe(false);
    expect(contentReaderFieldAllowed("article", parsed.permissions)).toBe(false);
    expect(contentReaderFieldAllowed("hidden", parsed.permissions)).toBe(false);
  });

  test("read, cite, export, and AI use are independent", () => {
    const readOnly = contentReaderPermissions({ contentActions: ["read"], aiActions: [] });
    const citeOnly = contentReaderPermissions({ contentActions: ["cite"], aiActions: ["research"] });
    const full = contentReaderPermissions({ contentActions: ["read", "cite", "export"], aiActions: ["generate"] });
    expect(readOnly.ok && citeOnly.ok && full.ok).toBe(true);
    if (!readOnly.ok || !citeOnly.ok || !full.ok) return;
    expect(readOnly.permissions.export).toBe(false);
    expect(readOnly.permissions.aiUse).toBe(false);
    expect(contentReaderFieldAllowed("body", readOnly.permissions)).toBe(true);
    expect(contentReaderFieldAllowed("excerpt", readOnly.permissions)).toBe(false);
    expect(citeOnly.permissions.aiUse).toBe(false);
    expect(contentReaderFieldAllowed("excerpt", citeOnly.permissions)).toBe(true);
    expect(contentReaderFieldAllowed("body", citeOnly.permissions)).toBe(false);
    expect(full.permissions).toMatchObject({ read: true, cite: true, export: true, aiUse: true, metadataOnly: false });
  });

  test("unknown actions fail closed", () => {
    expect(contentReaderPermissions({ contentActions: ["read", "admin"], aiActions: [] }).ok).toBe(false);
  });
});

describe("content reader exchange input", () => {
  test("accepts only a content public id", () => {
    expect(contentReaderExchangeRequestSchema.safeParse({ contentPublicId: "law-2024-1" }).success).toBe(true);
    expect(contentReaderExchangeRequestSchema.safeParse({ contentPublicId: "content_item:abc" }).success).toBe(false);
    expect(contentReaderExchangeRequestSchema.safeParse({
      contentPublicId: "law-2024-1",
      entitlementRevision: "9",
    }).success).toBe(false);
    expect(CLIENT_AUTHORITY_FIELDS).toContain("lease_end");
  });

  test("formats a positive entitlement revision for the IdP identity pattern", () => {
    expect(formatEntitlementRevision(12)).toEqual({ ok: true, entitlementRevision: "12" });
    expect(formatEntitlementRevision(0).ok).toBe(false);
  });
});
