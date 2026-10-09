import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { jsonify, Surreal } from "surrealdb";
import { ProTrialObservation } from "./pro-trial-observation";

const enabled = process.env.RUN_LOCAL_SURREALDB_PRO_TRIAL_TESTS === "1";
const localTest = test.skipIf(!enabled);
const db = new Surreal();
let child: ReturnType<typeof Bun.spawn> | undefined;
const observation = new ProTrialObservation(async () => db);
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
  for (const file of ["001-init.surql", "004-quota-commercial-authority.surql", "026-explicit-pro-trial.surql"]) await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
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

localTest("real configuration and account read twice without changing any control-plane facts", async () => {
  await db.query(`
    LET $now = time::now();
    CREATE pro_trial_claim:live CONTENT { billing_account: billing_account:a, subject: "owner", name: "Private", slug: "live",
      request_key: "private-key", started_at: $now - 1d, ends_at: $now + 6d,
      offer: { revision: "pro_trial_revision:test", productRevision: "product_plan_revision:test", resourceRevision: "quota_plan_revision:test" },
      state: "provisioning", lease: "private-lease", lease_until: time::now() + 10m };
    CREATE pro_trial_slot:live CONTENT { billing_account: billing_account:a, current_claim: pro_trial_claim:live };
    CREATE pro_trial_claim:expired CONTENT { billing_account: billing_account:b, subject: "owner", name: "Private", slug: "expired",
      request_key: "private-key", started_at: $now - 8d, ends_at: $now - 1d, offer: {}, state: "active" };
    CREATE pro_trial_slot:expired CONTENT { billing_account: billing_account:b, current_claim: pro_trial_claim:expired };
    CREATE quota_subscription:live CONTENT { billing_account: billing_account:a, source: "manual", status: "trialing", revision: 1,
      trial_start: time::now() - 1d, trial_end: time::now() + 1d, correlation_id: "test" };
    CREATE quota_subscription:live2 CONTENT { billing_account: billing_account:a, source: "manual", status: "trialing", revision: 1,
      trial_start: time::now() - 1d, trial_end: time::now() + 2d, correlation_id: "test" };
    CREATE pro_trial_claim:unlinked CONTENT { billing_account: billing_account:a, subject: "owner", name: "Private", slug: "unlinked",
      request_key: "second-key", started_at: $now - 1d, ends_at: $now + 6d, offer: {}, state: "active" };
    CREATE quota_subscription:expired CONTENT { billing_account: billing_account:a, source: "manual", status: "trialing", revision: 1,
      trial_start: time::now() - 2d, trial_end: time::now() - 1d, correlation_id: "test" };
    CREATE quota_subscription:future CONTENT { billing_account: billing_account:a, source: "manual", status: "trialing", revision: 1,
      trial_start: time::now() + 1d, trial_end: time::now() + 2d, correlation_id: "test" };
  `);
  const snapshotSql = `SELECT * FROM pro_trial_configuration; SELECT * FROM pro_trial_revision;
    SELECT * FROM pro_trial_eligibility; SELECT * FROM pro_trial_slot; SELECT * FROM pro_trial_claim;
    SELECT * FROM quota_subscription; SELECT * FROM billing_account; SELECT * FROM billing_account_member;`;
  const before = jsonify(await db.query(snapshotSql));
  for (let i = 0; i < 2; i++) {
    const config = await observation.configuration();
    expect(config.configurationState).toBe("present");
    expect(config.configuration?.enabled).toBe(true);
    expect(config.revision).toMatchObject({ id: "pro_trial_revision:test", fixture: true, approved_by: "test" });
    expect(config.configuration?.updated_at).toBeString();
    const account = await observation.account("a", "owner");
    expect(account).toMatchObject({ active: true, administrator: true, eligible: true });
    expect(account.trials.map(t => t.id).sort()).toEqual(["quota_subscription:live", "quota_subscription:live2"]);
    expect(account.claims).toHaveLength(2);
    expect(account.claims.find(c => c.id === "pro_trial_claim:live")).toMatchObject({ unexpired: true, leaseHeld: true, revision: "pro_trial_revision:test" });
    const expired = await observation.account("b", "owner");
    expect(expired.slots).toHaveLength(1);
    expect(expired.claims[0]).toMatchObject({ unexpired: false, leaseHeld: false, revision: null });
    const serialized = JSON.stringify([config, account, expired]);
    for (const secret of ["private-key", "private-lease", "Private", "approval_reason", "request_key"]) expect(serialized).not.toContain(secret);
  }
  expect(jsonify(await db.query(snapshotSql))).toEqual(before);
});

localTest("missing, disabled, inactive and non-admin are distinguishable; no cross-account results", async () => {
  expect(await observation.account("missing", "owner")).toMatchObject({ accountState: "missing", active: null, eligible: null, administrator: null, claims: [], trials: [], slots: [] });
  await db.query(`CREATE billing_account_member CONTENT { billing_account: billing_account:a, subject: "admin", role: "admin", status: "active" };
    CREATE billing_account_member CONTENT { billing_account: billing_account:a, subject: "viewer", role: "viewer", status: "active" };
    CREATE pro_trial_slot:dangling CONTENT { billing_account: billing_account:missing, current_claim: pro_trial_claim:missing };`);
  expect(await observation.account("missing", "owner")).toMatchObject({ accountState: "missing", slots: [], trials: [], claims: [] });
  expect(await observation.account("a", "admin")).toMatchObject({ administrator: true, membership: { role: "admin", status: "active" } });
  expect(await observation.account("a", "viewer")).toMatchObject({ administrator: false, membership: { role: "viewer", status: "active" } });
  await db.query('UPDATE billing_account_member SET status = "revoked" WHERE subject = "admin";');
  expect(await observation.account("a", "admin")).toMatchObject({ administrator: false });
  expect(await observation.account("a", "workspace-admin")).toMatchObject({ administrator: false, membership: null });
  await db.query('UPDATE billing_account:b SET status = "closed"; UPDATE pro_trial_eligibility SET enabled = false WHERE billing_account = billing_account:b;');
  expect(await observation.account("b", "owner")).toMatchObject({ active: false, eligibilityState: "disabled", eligible: false });
  await db.query('UPDATE pro_trial_slot:expired SET current_claim = pro_trial_claim:missing;');
  expect((await observation.account("b", "owner")).slots[0]).toMatchObject({ claimState: "missing", blocksNewClaim: null });
  await db.query('DELETE pro_trial_eligibility WHERE billing_account = billing_account:b;');
  expect(await observation.account("b", "owner")).toMatchObject({ eligibilityState: "missing", eligible: null });
  await db.query('UPDATE pro_trial_configuration:current SET revision = pro_trial_revision:missing;');
  expect(await observation.configuration()).toMatchObject({ configurationState: "present", revisionState: "missing", revision: null });
  await db.query('DELETE pro_trial_configuration:current;');
  expect(await observation.configuration()).toMatchObject({ configurationState: "missing", revisionState: "not_referenced", configuration: null, revision: null });
});

localTest("exact trial/lease boundary is expired on the database clock", async () => {
  await db.query(`LET $now = time::now(); UPDATE pro_trial_claim:live SET started_at = $now - 7d, ends_at = $now, lease_until = $now;
    UPDATE quota_subscription SET trial_end = $now WHERE id IN [quota_subscription:live, quota_subscription:live2];`);
  const result = await observation.account("a", "owner");
  expect(result.trials).toHaveLength(0);
  expect(result.claims.find(c => c.id === "pro_trial_claim:live")).toMatchObject({ unexpired: false, leaseHeld: false });
});
