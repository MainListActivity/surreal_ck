import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { Surreal } from "surrealdb";
import { SurrealTrialStore } from "./pro-trial-store";
import type { TrialOffer } from "./pro-trial";

const enabled = process.env.RUN_LOCAL_SURREALDB_PRO_TRIAL_TESTS === "1";
const localTest = test.skipIf(!enabled);
const db = new Surreal();
let child: ReturnType<typeof Bun.spawn> | undefined;
const offer: TrialOffer = { revision: "pro_trial_revision:test", productRevision: "product_plan_revision:test", resourceRevision: "quota_plan_revision:test",
  researchRate: 2, rateRevision: 2, resourcePlanKey: "trial", collections: [{ key: "synthetic", label: "不可售合成夹具" }], allowance: 10,
  capacity: [{ label: "表", limit: 2 }], reminderHours: [24], fixture: true };
class FixtureStore extends SurrealTrialStore {
  override async offer() { return offer; }
}
const store = new FixtureStore(async () => db);
beforeAll(async () => {
  if (!enabled) return;
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const a = s.address();
      if (!a || typeof a === "string") return reject(new Error("port allocation failed")); s.close(() => resolve(a.port)); });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  // Only company fork; credentials below are ephemeral local test fixtures.
  child = Bun.spawn([process.env.SURREAL_BINARY ?? `${process.env.HOME}/.surrealdb/surreal`, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "local-test", "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let n = 0; n < 50; n++) { try { if ((await fetch(`${endpoint}/health`)).ok) break; } catch { /* startup */ } await Bun.sleep(100); }
  await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "local-test" } });
  await db.query("DEFINE NAMESPACE IF NOT EXISTS main;");
  await db.use({ namespace: "main" });
  await db.query("DEFINE DATABASE IF NOT EXISTS _system;");
  await db.use({ namespace: "main", database: "_system" });
  for (const file of ["001-init.surql", "004-quota-commercial-authority.surql", "023-explicit-pro-trial.surql"]) await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
  await db.query(`CREATE billing_account:a CONTENT { account_key: "a", name: "Synthetic", kind: "personal", status: "active" };
    CREATE billing_account:b CONTENT { account_key: "b", name: "Synthetic B", kind: "personal", status: "active" };
    CREATE pro_trial_revision:test CONTENT { product_revision: product_plan_revision:test, duration_days: 7, research_rate: 2, rate_revision: 2, reminder_hours: [24], fixture: true, approved_by: "test", approval_reason: "synthetic" };
    CREATE pro_trial_configuration:current CONTENT { revision: pro_trial_revision:test, enabled: true, updated_by: "test" };
    CREATE billing_account_member CONTENT { billing_account: billing_account:a, subject: "owner", role: "owner", status: "active" };
    CREATE billing_account_member CONTENT { billing_account: billing_account:b, subject: "owner", role: "owner", status: "active" };
    CREATE pro_trial_eligibility CONTENT { billing_account: billing_account:a, enabled: true, reason: "synthetic", approved_by: "test" };
    CREATE pro_trial_eligibility CONTENT { billing_account: billing_account:b, enabled: true, reason: "synthetic", approved_by: "test" };`);
});
afterAll(async () => { await db.close(); child?.kill(); if (child) await child.exited; });
localTest("authoritative billing role: workspace admin/member cannot claim", async () => {
  await expect(store.claim({ subject: "workspace-admin", accountKey: "a", name: "A", slug: "trial-a", offerRevision: offer.revision, key: "forbidden" })).rejects.toMatchObject({ status: 403 });
});
localTest("parallel same request produces one claim/workspace identity; changed key cannot obtain another", async () => {
  const input = { subject: "owner", accountKey: "a", name: "A", slug: "trial-a", offerRevision: offer.revision, key: "parallel" };
  const results = await Promise.all(Array.from({ length: 4 }, () => store.claim(input)));
  expect(new Set(results.map(r => r.claim.id)).size).toBe(1);
  expect(results.filter(r => r.lease !== null)).toHaveLength(1);
  const c = results[0]!.claim;
  expect(Date.parse(c.endsAt) - Date.parse(c.startedAt)).toBe(7 * 86400000);
  await expect(store.claim({ ...input, key: "another", slug: "another" })).rejects.toMatchObject({ status: 409 });
  await expect(store.claim({ ...input, name: "changed" })).rejects.toMatchObject({ status: 409 });
  const acquired = results.find(r => r.lease)!;
  await store.finish(acquired.claim, acquired.lease!, false);
  const retried = await store.claim(input);
  expect(retried.claim.startedAt).toBe(c.startedAt);
  expect(retried.lease).not.toBeNull();
  await store.finish(retried.claim, retried.lease!, true);
  expect((await store.claim(input)).claim.state).toBe("active");
  await db.query("UPDATE pro_trial_configuration:current SET enabled = false;");
  const realStore = new SurrealTrialStore(async () => db);
  expect((await realStore.claim(input)).claim.offer).toEqual(offer);
  await expect(realStore.claim({ ...input, subject: "workspace-admin" })).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE pro_trial_configuration:current SET enabled = true;");
});
localTest("stale offer and exact expiry fail without extending the original period", async () => {
  await expect(store.claim({ subject: "owner", accountKey: "a", name: "A", slug: "trial-a", key: "parallel", offerRevision: "pro_trial_revision:stale" })).rejects.toMatchObject({ status: 409 });
  await db.query("LET $end = time::now(); UPDATE pro_trial_claim SET started_at = $end - 7d, ends_at = $end WHERE slug = 'trial-a';");
  await expect(store.claim({ subject: "owner", accountKey: "a", name: "A", slug: "trial-a", key: "parallel", offerRevision: offer.revision })).rejects.toMatchObject({ status: 409 });
});

localTest("accounts isolate eligibility and revoke authority on replay", async () => {
  const independent = await store.claim({ subject: "owner", accountKey: "b", name: "B", slug: "trial-b", offerRevision: offer.revision, key: "parallel" });
  expect(independent.claim.slug).toBe("trial-b");
  await db.query("UPDATE pro_trial_eligibility SET enabled = false WHERE billing_account = billing_account:b;");
  await expect(store.claim({ subject: "owner", accountKey: "b", name: "B", slug: "trial-b", offerRevision: offer.revision, key: "parallel" })).rejects.toMatchObject({ status: 403 });
});
