import { test, expect } from "bun:test";
import type { AiDeliveryProof, SessionUser } from "@surreal-ck/shared";
import { HttpError } from "../http-error";
import { createDeliveryVerifierFactory, type DeliveryVerifierDeps } from "./delivery-verify";
import type { SnapshotRecord } from "../product-entitlement/service";

const DB = "ws_test";
const user: SessionUser = { subject: "member", rawToken: "t", raw: { db: DB, exp: Math.floor(Date.now() / 1000) + 3600 } };
const VERSION = "content_version:v";

function proof(overrides: Partial<AiDeliveryProof["authorization"]> = {}, platform = [{ versionId: VERSION, bodySha256: "sha", cite: true }]): AiDeliveryProof[] {
  return [{ authorization: { workspaceId: DB, kind: "ready", revision: "1", digest: "sha256:fixture", ...overrides }, platform, private: [] }];
}

const factRow = {
  version: VERSION, item: "content_item:i", public_id: "v", body_sha256: "sha",
  source_status: "active", publication_status: "published",
  license: "source_license_revision:l", license_actions: ["browse", "search", "read", "cite", "export", "research", "generate"],
  license_from: new Date(Date.now() - 60_000).toISOString(), license_until: null, collections: ["core"],
};

const snapshot: SnapshotRecord = {
  id: "workspace_product_entitlement:x", workspaceId: "workspace:ws", workspaceSlug: "ws",
  revision: 1, digest: "sha256:fixture", summary: "s", resolverVersion: "test",
  baseSourceKind: "subscription", baseSourceId: "b", productPlanRevisionId: null,
  productPlanKey: null, productPlanName: null, productRevisionNumber: null,
  effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveUntil: null,
  collections: [{ key: "core", label: "core" }], actions: ["browse", "read", "cite"],
  sources: [], aiActions: ["research"], features: [], correlationId: "c",
};

function deps(overrides: Partial<DeliveryVerifierDeps> = {}, fact: unknown = factRow, snap: SnapshotRecord | null = snapshot): DeliveryVerifierDeps {
  return {
    systemSession: async () => ({ query: async () => [[{ subject: "member", disabled_at: null, workspace: { id: "workspace:ws", status: "active" } }]] }),
    workspaceSession: async () => ({ query: async () => [[{ id: "user:m", disabled_at: null }]] }),
    contentSession: async () => ({ query: async () => [fact] }),
    currentSnapshot: async () => snap,
    rolloutGates: async () => "enabled",
    ...overrides,
  };
}

const verify = (d: DeliveryVerifierDeps, u: SessionUser = user) => createDeliveryVerifierFactory(d)(u);

test("valid facts + current snapshot recover without IdP exchange", async () => {
  let exchange = 0;
  await verify(deps({ systemSession: async () => ({ query: async () => { exchange++; return [[{ subject: "member", disabled_at: null, workspace: { id: "workspace:ws", status: "active" } }]]; } }) }))(proof());
  expect(exchange).toBe(1); // 仅成员索引一读，无 IdP/投影交互
});

test("authorization epoch mismatch rejects stale answers", async () => {
  for (const p of [
    proof({ revision: "2" }),
    proof({ digest: "sha256:other" }),
    proof({ workspaceId: "ws_other" }),
    proof({ kind: "empty" }),
  ]) {
    await expect(verify(deps())(p)).rejects.toMatchObject({ status: 409, code: "authorization_changed" });
  }
});

test("caller membership/workspace/identity failures deny", async () => {
  const cases: DeliveryVerifierDeps[] = [
    deps({ systemSession: async () => ({ query: async () => [[{ subject: "member", disabled_at: new Date().toISOString(), workspace: { id: "workspace:ws", status: "active" } }]] }) }),
    deps({ systemSession: async () => ({ query: async () => [[{ subject: "other", disabled_at: null, workspace: { id: "workspace:ws", status: "active" } }]] }) }),
    deps({ systemSession: async () => ({ query: async () => [[{ subject: "member", disabled_at: null, workspace: { id: "workspace:ws", status: "suspended" } }]] }) }),
    deps({ workspaceSession: async () => ({ query: async () => [[]] }) }),
    deps({ rolloutGates: async () => "disabled" }),
    deps({}, factRow, null),
    deps({}, factRow, { ...snapshot, effectiveUntil: new Date(Date.now() - 1000).toISOString() }),
  ];
  for (const d of cases) {
    await expect(verify(d)(proof())).rejects.toMatchObject({ status: 409 });
  }
  await expect(verify(deps(), { ...user, raw: {} })(proof())).rejects.toMatchObject({ status: 409 });
  await expect(verify(deps(), { ...user, raw: { db: DB, ac: "content_reader", exp: Math.floor(Date.now() / 1000) + 60 } })(proof())).rejects.toMatchObject({ status: 409 });
});

test("fact mutations deny: withdrawn, license expired, actions/collection revoked, body changed, version gone", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const cases: unknown[] = [
    { ...factRow, publication_status: "withdrawn" },
    { ...factRow, publication_status: "draft" },
    { ...factRow, source_status: "disabled" },
    { ...factRow, license_until: past },
    { ...factRow, license_actions: ["browse", "search", "read", "cite"] },          // ai actions gone
    { ...factRow, license_actions: ["browse", "research", "generate"] },            // read/cite gone
    { ...factRow, collections: ["other"] },
    { ...factRow, body_sha256: "tampered" },
    { ...factRow, license_from: null },
    null,
  ];
  for (const fact of cases) {
    await expect(verify(deps({}, fact))(proof())).rejects.toMatchObject({ status: 409 });
  }
});

test("entitlement without ai/read/cite denies matching platform evidence", async () => {
  for (const [snapPatch, platform] of [
    [{ aiActions: [] }, proof()[0]!.platform],
    [{ actions: ["browse"] }, proof()[0]!.platform],
    [{ actions: ["browse", "read"] }, proof()[0]!.platform],
  ] as Array<[Partial<SnapshotRecord>, AiDeliveryProof["platform"]]>) {
    await expect(verify(deps({}, factRow, { ...snapshot, ...snapPatch }))(proof({}, platform))).rejects.toMatchObject({ status: 409 });
  }
  // 引用证据但许可未授 cite → 拒；不引用 → 可恢复
  await expect(verify(deps({}, { ...factRow, license_actions: ["read", "research"] }))(proof())).rejects.toMatchObject({ status: 409 });
  await verify(deps({}, { ...factRow, license_actions: ["read", "research"] }))(proof({}, [{ versionId: VERSION, bodySha256: "sha", cite: false }]));
});

test("infrastructure failures surface retryable 503, not authorization_changed", async () => {
  for (const d of [
    deps({ systemSession: async () => { throw new Error("system down"); } }),
    deps({ workspaceSession: async () => { throw new Error("ws down"); } }),
    deps({ contentSession: async () => ({ query: async () => { throw new Error("content down"); } }) }),
    deps({ currentSnapshot: async () => { throw new Error("snapshot down"); } }),
    deps({ rolloutGates: async () => { throw new Error("gate down"); } }),
  ]) {
    const error = await verify(d)(proof()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).code).toBe("chat-delivery-verify-unavailable");
  }
});
