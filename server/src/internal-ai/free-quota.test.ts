import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import {
  MAGPIE_B_ENVELOPE, MAGPIE_FREE_BASIS_DECISION, MAGPIE_FREE_BASIS_ROUTE, MAGPIE_FREE_BASIS_VERSION,
  MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, MAGPIE_LOCAL_FRESHNESS_SECONDS, MAGPIE_REMOTE_EVIDENCE_VERSION,
  magpieFreeQuotaBasisSchema, type MagpieFreeQuotaBasis, type MagpieFreeQuotaRemoteWindowCreate, type MagpieRemoteWindowCreate,
} from "@surreal-ck/shared";
import {
  basisRouteStop, buildFreeQuotaRemoteWindowRequest, classifyProviderFailure, freeQuotaBasisContent,
  freeQuotaBasisHash, freeQuotaBeginStop, freeQuotaFinishStop, isFreeQuotaWindow, readFreeQuotaBasis,
  type FreeQuotaWindowContext,
} from "./free-quota";
import { canonicalJson, WindowDenied, type WindowRow } from "./window";

const digest = (c: string) => c.repeat(64);
const hexHash = (content: string): string => createHash("sha256").update(content).digest("hex");
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof WindowDenied ? e.code : `unexpected:${String(e)}`; }
  return "no-throw";
};

/** 老板决定之后的生效时刻；到期取 B 包络期限（2026-11-05T12:10:07Z）。 */
const EFFECTIVE = "2026-10-30T22:00:00Z";
const ENDPOINT = `https://${MAGPIE_FREE_BASIS_ROUTE.host}${MAGPIE_FREE_BASIS_ROUTE.path}`;
const runtime = { providerId: "openai", modelId: "group/work", endpoint: ENDPOINT };

function basis(overrides: Partial<MagpieFreeQuotaBasis> = {}): MagpieFreeQuotaBasis {
  return {
    version: MAGPIE_FREE_BASIS_VERSION,
    decision: { ...MAGPIE_FREE_BASIS_DECISION },
    route: { ...MAGPIE_FREE_BASIS_ROUTE },
    envelope: MAGPIE_B_ENVELOPE.id,
    effectiveAt: EFFECTIVE,
    expiresAt: MAGPIE_B_ENVELOPE.expiresAt,
    ...overrides,
  };
}

/** 账本行只取依据门禁读取的字段；其余字段对这些门禁无影响。 */
function freeWindow(overrides: Partial<WindowRow> = {}): WindowRow {
  return {
    id: new RecordId("internal_ai_window", "free-w1"),
    activity: "free-unit",
    envelope: MAGPIE_B_ENVELOPE.id,
    contract_version: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION,
    free_evidence_hash: freeQuotaBasisHash(basis()),
    endpoint: ENDPOINT,
    requested_model: "group/work",
    served_model: MAGPIE_FREE_BASIS_ROUTE.servedModel,
    status: "active",
    attempts: 0,
    attempt_limit: 1,
    evidence_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  } as WindowRow;
}

describe("free-quota basis record", () => {
  test("hash is the sha256 of canonical content: key order is irrelevant and any field change moves it", () => {
    const reordered: MagpieFreeQuotaBasis = {
      expiresAt: MAGPIE_B_ENVELOPE.expiresAt, effectiveAt: EFFECTIVE, envelope: MAGPIE_B_ENVELOPE.id,
      route: { servedModel: MAGPIE_FREE_BASIS_ROUTE.servedModel, path: MAGPIE_FREE_BASIS_ROUTE.path, host: MAGPIE_FREE_BASIS_ROUTE.host },
      decision: { scope: MAGPIE_FREE_BASIS_DECISION.scope, decidedAt: MAGPIE_FREE_BASIS_DECISION.decidedAt, actor: MAGPIE_FREE_BASIS_DECISION.actor, kind: MAGPIE_FREE_BASIS_DECISION.kind, sourceTask: MAGPIE_FREE_BASIS_DECISION.sourceTask },
      version: MAGPIE_FREE_BASIS_VERSION,
    };
    expect(freeQuotaBasisContent(basis())).toBe(canonicalJson(basis()));
    expect(freeQuotaBasisHash(reordered)).toBe(freeQuotaBasisHash(basis()));
    expect(freeQuotaBasisHash(basis())).toMatch(/^[0-9a-f]{64}$/);
    expect(freeQuotaBasisHash(basis({ expiresAt: "2026-11-04T12:10:07Z" }))).not.toBe(freeQuotaBasisHash(basis()));
    expect(freeQuotaBasisHash(basis({ effectiveAt: "2026-10-31T00:00:00Z" }))).not.toBe(freeQuotaBasisHash(basis()));
  });

  test("readFreeQuotaBasis recomputes the hash and refuses tampered, non-canonical or foreign content", () => {
    const content = freeQuotaBasisContent(basis());
    const hash = freeQuotaBasisHash(basis());
    expect(readFreeQuotaBasis(content, hash)).toEqual(basis());
    // 篡改内容但保留原 hash：sha256 不再匹配。
    expect(readFreeQuotaBasis(content.replace(MAGPIE_FREE_BASIS_ROUTE.servedModel, "other-model"), hash)).toBeNull();
    // 同一依据的非规范形式（带空白）：即使用它自己的 sha256，也因非规范形式被拒。
    const pretty = JSON.stringify(basis(), null, 2);
    expect(readFreeQuotaBasis(pretty, hexHash(pretty))).toBeNull();
    // 篡改并重算 hash：固定字面量的 schema 仍拒绝外部主机。
    const foreign = canonicalJson(basis({ route: { ...MAGPIE_FREE_BASIS_ROUTE, host: "evil.example.com" } as MagpieFreeQuotaBasis["route"] }));
    expect(readFreeQuotaBasis(foreign, hexHash(foreign))).toBeNull();
    expect(readFreeQuotaBasis("not json", hexHash("not json"))).toBeNull();
  });

  test("the basis schema pins the decision, the route, the envelope and the envelope end", () => {
    expect(magpieFreeQuotaBasisSchema.safeParse(basis()).success).toBe(true);
    const rejected: Partial<MagpieFreeQuotaBasis>[] = [
      { effectiveAt: "2026-10-30T21:00:00Z" },
      { expiresAt: "2026-11-05T12:10:08Z" },
      { expiresAt: EFFECTIVE },
      { envelope: "fv06-other" as typeof MAGPIE_B_ENVELOPE.id },
    ];
    for (const overrides of rejected) expect(magpieFreeQuotaBasisSchema.safeParse(basis(overrides)).success).toBe(false);
    expect(magpieFreeQuotaBasisSchema.safeParse({ ...basis(), price: 0 }).success).toBe(false);
  });
});

describe("free-quota route and model checks", () => {
  test("basisRouteStop accepts only the exact https host, path and served model", () => {
    const b = basis();
    expect(basisRouteStop(b, ENDPOINT, MAGPIE_FREE_BASIS_ROUTE.servedModel)).toBeNull();
    expect(basisRouteStop(b, `${ENDPOINT}/`, MAGPIE_FREE_BASIS_ROUTE.servedModel)).toBeNull();
    for (const endpoint of [
      `http://${MAGPIE_FREE_BASIS_ROUTE.host}${MAGPIE_FREE_BASIS_ROUTE.path}`,
      `https://${MAGPIE_FREE_BASIS_ROUTE.host}:8443${MAGPIE_FREE_BASIS_ROUTE.path}`,
      `https://${MAGPIE_FREE_BASIS_ROUTE.host}/other/v1`,
      "https://evil.example.com/ofm/v1",
      `https://user:x@${MAGPIE_FREE_BASIS_ROUTE.host}${MAGPIE_FREE_BASIS_ROUTE.path}`,
      `${ENDPOINT}?x=1`,
      "not a url",
    ]) expect(basisRouteStop(b, endpoint, MAGPIE_FREE_BASIS_ROUTE.servedModel)).toBe("route-drift");
    expect(basisRouteStop(b, ENDPOINT, "sn-other-model")).toBe("served-model-drift");
  });

  test("freeQuotaBeginStop closes the window on a missing, unready, expired or drifted basis", () => {
    const b = basis();
    const w = freeWindow();
    const at = Date.parse("2026-10-31T10:00:00Z");
    expect(freeQuotaBeginStop(b, w, at)).toBeNull();
    expect(freeQuotaBeginStop(null, w, at)).toBe("free-basis-invalid");
    expect(freeQuotaBeginStop(b, freeWindow({ free_evidence_hash: digest("f") }), at)).toBe("free-basis-invalid");
    expect(freeQuotaBeginStop(b, freeWindow({ envelope: null }), at)).toBe("free-basis-invalid");
    expect(freeQuotaBeginStop(b, w, Date.parse(EFFECTIVE) - 1)).toBe("free-basis-invalid");
    expect(freeQuotaBeginStop(b, w, Date.parse(b.expiresAt) - 1)).toBeNull();
    expect(freeQuotaBeginStop(b, w, Date.parse(b.expiresAt))).toBe("free-basis-expired");
    expect(freeQuotaBeginStop(b, freeWindow({ endpoint: `https://${MAGPIE_FREE_BASIS_ROUTE.host}/other/v1` }), at)).toBe("route-drift");
    expect(freeQuotaBeginStop(b, freeWindow({ served_model: "sn-other-model" }), at)).toBe("served-model-drift");
  });

  test("freeQuotaFinishStop lets only free-evidence continue and stops every other status", () => {
    expect(freeQuotaFinishStop("free-evidence")).toBeNull();
    expect(freeQuotaFinishStop("route-drift")).toBe("served-model-drift");
    expect(freeQuotaFinishStop("usage-missing")).toBe("usage-missing");
    expect(freeQuotaFinishStop("invalid-usage")).toBe("usage-invalid");
    for (const status of ["provider-failed", "unassessed", "unknown", "assessed"] as const) {
      expect(freeQuotaFinishStop(status)).toBe("provider-uncertain");
    }
  });

  test("only v3 rows are free-quota windows", () => {
    expect(isFreeQuotaWindow({ contract_version: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION })).toBe(true);
    for (const version of ["magpie-window/v2", "magpie-window/v1", null, undefined]) {
      expect(isFreeQuotaWindow({ contract_version: version })).toBe(false);
    }
  });
});

describe("provider failure classification", () => {
  test("failures are classified by shape; unknown shapes stay provider-uncertain", () => {
    expect(classifyProviderFailure({ statusCode: 402 })).toBe("billing-required");
    expect(classifyProviderFailure({ response: { status: 402 } })).toBe("billing-required");
    expect(classifyProviderFailure(new Error("insufficient_quota: You exceeded your current quota"))).toBe("quota-exhausted");
    expect(classifyProviderFailure({ status: 429, error: { message: "quota exceeded for this key" } })).toBe("quota-exhausted");
    expect(classifyProviderFailure(new Error("额度已用尽"))).toBe("quota-exhausted");
    expect(classifyProviderFailure(new Error("billing hard limit reached"))).toBe("billing-required");
    expect(classifyProviderFailure(new Error("subscription expired"))).toBe("billing-required");
    expect(classifyProviderFailure(new Error("socket hang up"))).toBe("provider-uncertain");
    expect(classifyProviderFailure({ status: 500, message: "internal error" })).toBe("provider-uncertain");
    expect(classifyProviderFailure(undefined)).toBe("provider-uncertain");
  });
});

describe("free-quota remote window builder", () => {
  const CATALOG_REVISION = "remote-magpie-catalog-285bd6a56db6";

  /** 与 window-remote 单元测试同构的 null+gap 远端证据；时间取新鲜值。 */
  function evidence(endpoint = ENDPOINT, overrides: Partial<MagpieRemoteWindowCreate["evidence"]> = {}): MagpieRemoteWindowCreate["evidence"] {
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const freshness = new Date(Date.parse(capturedAt) + MAGPIE_LOCAL_FRESHNESS_SECONDS * 1000).toISOString();
    return {
      version: MAGPIE_REMOTE_EVIDENCE_VERSION,
      source: { kind: "configured-remote-magpie", endpoint, model: "remote-magpie/group/work", executionHost: "remote" },
      observation: { capturedAt, digest: digest("d"), routingConfigurationVerified: false },
      accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
      accountBinding: "mgpc0cfa2b2cd201c321bc7b42a",
      route: {
        present: true, group: "group/work", revision: null, digest: null,
        servedModel: MAGPIE_FREE_BASIS_ROUTE.servedModel, sampledAt: "2026-10-28T08:08:15.89838551Z", expiresAt: null,
        gaps: [
          { field: "revision", reason: "远端只读目录未提供该路由的 revision；不自行编造" },
          { field: "digest", reason: "远端只读接口未提供路由 digest；本工具不计算替代摘要" },
          { field: "expiresAt", reason: "远端只读接口未提供该路由的到期时刻" },
        ],
      },
      pricing: { priceRevision: CATALOG_REVISION, rawPrompt: "0", rawCompletion: "0", free: true, freeEvidence: "remote-catalog-zero", reviewed: false },
      expiry: { basis: "local-observation-freshness-policy", localFreshnessExpiresAt: freshness, sourceExpiresAt: [], expiresAt: freshness },
      budget: { currency: "USD", totalNanoUsd: 700_000_000, perAttemptNanoUsd: 35_000_000, maxAttempts: 20 },
      gaps: [
        { field: "route.revision", reason: "远端只读目录未提供该路由的 revision；不自行编造" },
        { field: "route.digest", reason: "远端只读接口未提供路由 digest；本工具不计算替代摘要" },
        { field: "route.expiresAt", reason: "远端只读接口未提供该路由的到期时刻" },
      ],
      configurationDigest: digest("c"),
      ...overrides,
    };
  }

  function freeInput(overrides: Partial<MagpieFreeQuotaRemoteWindowCreate> = {}): MagpieFreeQuotaRemoteWindowCreate {
    const ev = overrides.evidence ?? evidence();
    return {
      activity: "free-unit",
      approvalDigest: digest("a"),
      approvalTask: "cdc2dd4c-0000-4000-8000-000000000000",
      accountRef: "mgpc0cfa2b2cd201c321bc7b42a",
      evidenceExpiresAt: ev.expiry.expiresAt,
      sourceBudgetAttempts: 1,
      sourceBudgetNanoUsd: 35_000_000,
      perAttemptNanoUsd: 35_000_000,
      maxOutputTokens: 8192,
      evidence: ev,
      capacity: { database: "ws_ddad14a98469", entityTables: 4, fieldsPerTable: 12, recordsPerTable: 12, ttlSeconds: 3600, destructive: false, source: "9e44a95d" },
      idempotencyKey: "idem-free-unit-1",
      reason: "unit-test",
      envelope: MAGPIE_B_ENVELOPE.id,
      freeQuotaBasisHash: freeQuotaBasisHash(basis()),
      ...overrides,
    };
  }

  function ctx(overrides: Partial<FreeQuotaWindowContext> = {}): FreeQuotaWindowContext {
    return {
      totalUsed: 0, committedAttempts: 0, activityTotalLimit: 1_000_000_000, activityPerAttemptLimit: 100_000_000,
      envelopeUsed: 0, envelopeCommitted: 0, envelopeCommittedNanoUsd: 0, envelopeSpentNanoUsd: 0, envelopeReservedNanoUsd: 0,
      envelopeFreeStopped: false, runtime, basis: basis(), ...overrides,
    };
  }

  test("a stored, matching basis yields a v3 free-evidence request priced from the basis, not the catalog", () => {
    const hash = freeQuotaBasisHash(basis());
    const request = buildFreeQuotaRemoteWindowRequest(freeInput(), ctx());
    expect(request.contractVersion).toBe(MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION);
    expect(request.route.priceBasis).toBe("free-evidence");
    expect(request.route.freeEvidenceHash).toBe(hash);
    expect(request.route.priceRevision).toBe(`${MAGPIE_FREE_BASIS_VERSION}:${hash}`);
    expect(request.route.endpoint).toBe(ENDPOINT);
    expect(request.route.servedModel).toBe(MAGPIE_FREE_BASIS_ROUTE.servedModel);
    expect(request.remote?.pricingReviewed).toBe(false);
    expect(request.remote?.pricingEvidenceRevision).toBe(CATALOG_REVISION);
  });

  test("the builder refuses a missing, forged, premature, expired, drifted or conflicting basis", () => {
    const short = basis({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const shortHash = freeQuotaBasisHash(short);
    const base = evidence();
    const other = `https://${MAGPIE_FREE_BASIS_ROUTE.host}/other/v1`;
    // 目录 0/0 本身不是依据：没有落库依据即拒绝。
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput(), ctx({ basis: null })))).toBe("magpie-window-free-basis-unknown");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ freeQuotaBasisHash: digest("9") }), ctx()))).toBe("magpie-window-free-basis-invalid");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput(), ctx({ now: Date.parse(EFFECTIVE) - 1_000 })))).toBe("magpie-window-free-basis-not-effective");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ freeQuotaBasisHash: shortHash }), ctx({ basis: short, now: Date.parse(short.expiresAt) })))).toBe("magpie-window-free-basis-expired");
    // 证据期 7200s 超过了较短的依据期限：同样按依据过期拒绝。
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ freeQuotaBasisHash: shortHash }), ctx({ basis: short })))).toBe("magpie-window-free-basis-expired");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ evidence: evidence(other) }), ctx({ runtime: { ...runtime, endpoint: other } })))).toBe("magpie-window-free-basis-route-mismatch");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ evidence: { ...base, route: { ...base.route, servedModel: "sn-other-model" } } }), ctx()))).toBe("magpie-window-free-basis-route-mismatch");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ evidence: { ...base, pricing: { ...base.pricing, free: false } } }), ctx()))).toBe("magpie-window-free-basis-conflict");
    expect(code(() => buildFreeQuotaRemoteWindowRequest(freeInput({ evidence: { ...base, pricing: { ...base.pricing, rawPrompt: "0.000001" } } }), ctx()))).toBe("magpie-window-free-basis-conflict");
  });
});
