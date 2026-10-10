import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Surreal } from "surrealdb";
import { readInternalIdentity } from "./identity";

const enabled = process.env.RUN_INTERNAL_AI_FORK_TESTS === "1";
const localTest = test.skipIf(!enabled);
const binary = join(homedir(), ".surrealdb/surreal");
let directory = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;
beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "internal-ai-identity-fork-"));
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer(); listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address(); if (!address || typeof address === "string") { listener.close(); reject(new Error("port unavailable")); return; }
      listener.close(() => resolve(address.port));
    });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  child = Bun.spawn([binary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", `rocksdb:${join(directory, "data")}`], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 80; i++) {
    const probe = Bun.spawn([binary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited === 0) break;
    if (i === 79) throw new Error("company fork unavailable");
    await Bun.sleep(50);
  }
  db = new Surreal(); await db.connect(`${endpoint}/rpc`, { authentication: { username: "root", password: "root" } });
  await db.query("DEFINE NAMESPACE identity_test;");
  await db.use({ namespace: "identity_test" });
  await db.query("DEFINE DATABASE identity_test;");
  await db.use({ namespace: "identity_test", database: "identity_test" });
  for (const file of ["001-init.surql", "004-quota-commercial-authority.surql"]) {
    await db.query(await readFile(new URL(`../../../shared/sql/system/${file}`, import.meta.url), "utf8"));
  }
  await db.query(`CREATE workspace:fixture SET slug = 'fixture', db_name = 'ws_fixture', name = 'Synthetic', owner_subject = 'workspace-owner', status = 'active';
    CREATE billing_account:fixture SET account_key = 'fixture-account', name = 'Synthetic', kind = 'team', status = 'active';
    CREATE quota_subscription:fixture SET billing_account = billing_account:fixture, source = 'manual', status = 'active', revision = 1, correlation_id = 'synthetic';
    CREATE quota_subscription_item:fixture SET workspace = workspace:fixture, subscription = quota_subscription:fixture, plan_revision = quota_plan_revision:fixture, revision = 1, status = 'active', effective_from = time::now(), correlation_id = 'synthetic';
    CREATE user_workspace_index:owner SET workspace = workspace:fixture, subject = 'billing-owner', db_name = 'ws_fixture', role = 'admin';
    CREATE user_workspace_index:member SET workspace = workspace:fixture, subject = 'ordinary-member', db_name = 'ws_fixture', role = 'participant';
    CREATE billing_account_member:owner SET billing_account = billing_account:fixture, subject = 'billing-owner', role = 'owner', status = 'active';`);
}, 20000);
afterAll(async () => {
  try { await db?.close(); } finally { if (child) { child.kill(); await child.exited; } if (directory) await rm(directory, { recursive: true, force: true }); }
});
localTest("company fork validates real authority traversal and separate owner/member projections", async () => {
  if (!db) throw new Error("fixture unavailable");
  expect(await readInternalIdentity(db, "billing-owner", "fixture")).toMatchObject({ billingRole: "owner", workspaceRole: "admin", billingAccountRef: "fixture-account" });
  expect(await readInternalIdentity(db, "ordinary-member", "fixture")).toMatchObject({ billingRole: "member", workspaceRole: "participant" });
  await db.query("CREATE billing_account_member:member SET billing_account = billing_account:fixture, subject = 'ordinary-member', role = 'viewer', status = 'active';");
  expect((await readInternalIdentity(db, "ordinary-member", "fixture")).billingRole).toBe("member");
  await db.query("UPDATE billing_account_member:member SET role = 'admin';");
  await expect(readInternalIdentity(db, "ordinary-member", "fixture")).rejects.toThrow("内部身份不可用");
  await db.query("UPDATE billing_account_member:member SET status = 'revoked'; UPDATE user_workspace_index:member SET role = 'admin';");
  expect(await readInternalIdentity(db, "ordinary-member", "fixture")).toMatchObject({ billingRole: "member", workspaceRole: "admin" });
  await expect(readInternalIdentity(db, "nonmember", "fixture")).rejects.toThrow("内部身份不可用");
  await db.query("UPDATE user_workspace_index:member SET disabled_at = time::now();");
  await expect(readInternalIdentity(db, "ordinary-member", "fixture")).rejects.toThrow("内部身份不可用");
  await db.query("UPDATE quota_subscription:fixture SET status = 'paused';");
  await expect(readInternalIdentity(db, "billing-owner", "fixture")).rejects.toThrow("内部身份不可用");
  await db.query("UPDATE quota_subscription:fixture SET status = 'active'; UPDATE billing_account:fixture SET status = 'closed';");
  await expect(readInternalIdentity(db, "billing-owner", "fixture")).rejects.toThrow("内部身份不可用");
  await db.query("UPDATE billing_account:fixture SET status = 'active'; UPDATE quota_subscription_item:fixture SET status = 'ended';");
  await expect(readInternalIdentity(db, "billing-owner", "fixture")).rejects.toThrow("内部身份不可用");
});
