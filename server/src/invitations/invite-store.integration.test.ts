import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Surreal } from "surrealdb";

import { SurrealInviteAuditStore, type InviteOutcome } from "./invite-store";

const RUN_INTEGRATION = process.env.RUN_LOCAL_SURREALDB_INVITE_STORE_TESTS === "1";
const localTest = test.skipIf(!RUN_INTEGRATION);
const surrealBinary = process.env.SURREAL_BINARY ?? "surreal";
const namespace = "main";
const database = "_system";
const migrationsUrl = new URL("../../../shared/sql/system/", import.meta.url);

let endpoint = "";
let workingDirectory = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let db: Surreal | undefined;

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("failed to allocate SurrealDB port"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn(
      [surrealBinary, "is-ready", "--endpoint", endpoint],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await probe.exited) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("local SurrealDB did not become ready");
}

function store() {
  if (!db) throw new Error("integration database not initialized");
  const session = async () => db!;
  return new SurrealInviteAuditStore(session, database);
}

function outcome(bucket: string | null): InviteOutcome {
  return {
    idpUserId: "user-1",
    idpUserStatus: "invited",
    userOutcome: "created",
    workspaceDb: "ws_invite0001",
    workspaceOutcome: "created",
    productRevision: "product_plan_revision:1",
    contentAssigned: true,
    aiAllowance: {
      kind: "invite",
      amount: 500,
      periodKey: "invite:key",
      expiresAt: "2099-01-01T00:00:00.000Z",
      bucket,
    },
    deliveryChannel: "activation_url",
    activationUrlIssued: true,
  };
}

describe("SurrealInviteAuditStore.complete against local SurrealDB", () => {
  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    workingDirectory = await mkdtemp(join(tmpdir(), "surreal-ck-invite-store-"));
    const port = await allocatePort();
    endpoint = `ws://127.0.0.1:${port}`;
    server = Bun.spawn([
      surrealBinary,
      "start",
      "--no-banner",
      "--log",
      "none",
      "--bind",
      `127.0.0.1:${port}`,
      "--user",
      "root",
      "--pass",
      "root",
      `rocksdb:${join(workingDirectory, "data")}`,
    ], {
      cwd: workingDirectory,
      stdout: "ignore",
      stderr: "pipe",
    });
    await waitUntilReady();

    const bootstrap = new Surreal();
    await bootstrap.connect(`${endpoint}/rpc`, {
      authentication: { username: "root", password: "root" },
    });
    await bootstrap.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace};`);
    await bootstrap.use({ namespace });
    await bootstrap.query(`DEFINE DATABASE IF NOT EXISTS ${database};`);
    await bootstrap.close();

    db = new Surreal();
    await db.connect(`${endpoint}/rpc`, {
      authentication: { username: "root", password: "root" },
      namespace,
      database,
    });
    const migrations = (await readdir(migrationsUrl))
      .filter((entry) => /^\d{3}-.+\.surql$/u.test(entry))
      .sort();
    for (const migration of migrations) {
      await db.query(await readFile(new URL(migration, migrationsUrl), "utf8"));
    }
  });

  afterAll(async () => {
    await db?.close();
    server?.kill();
    if (server) await server.exited;
    if (workingDirectory) {
      await rm(workingDirectory, { force: true, recursive: true });
    }
  });

  localTest("writes ai_allowance.bucket as NONE when the grant has no bucket, and as a string when it does", async () => {
    const audit = store();
    const noneKey = "invite-bucket-none";
    const presentKey = "invite-bucket-present";
    const noneId = "ops_invitation:bucket_none";
    const presentId = "ops_invitation:bucket_present";

    expect(await audit.claim({
      recordId: noneId,
      idempotencyKey: noneKey,
      operatorSubject: "op",
      authorizedCapability: "invitation.create",
      email: "none@example.invalid",
      displayName: "None",
      workspaceSlug: "invite-none",
      workspaceName: "Invite none",
      planKey: "pro",
      reason: "bucket none fixture",
      requestDigest: "digest-none",
    })).toEqual({ kind: "claimed" });
    await audit.complete(noneId, outcome(null));

    expect(await audit.claim({
      recordId: presentId,
      idempotencyKey: presentKey,
      operatorSubject: "op",
      authorizedCapability: "invitation.create",
      email: "present@example.invalid",
      displayName: "Present",
      workspaceSlug: "invite-present",
      workspaceName: "Invite present",
      planKey: "pro",
      reason: "bucket present fixture",
      requestDigest: "digest-present",
    })).toEqual({ kind: "claimed" });
    await audit.complete(presentId, outcome("ai_allowance_bucket:1"));

    const noneRow = await audit.byKey(noneKey);
    const presentRow = await audit.byKey(presentKey);
    expect(noneRow?.status).toBe("completed");
    expect(noneRow?.outcome?.aiAllowance.bucket).toBeNull();
    expect(presentRow?.status).toBe("completed");
    expect(presentRow?.outcome?.aiAllowance.bucket).toBe("ai_allowance_bucket:1");

    const raw = await db!.query<Array<Array<Record<string, unknown>>>>(
      "SELECT ai_allowance.bucket AS bucket FROM ops_invitation WHERE idempotency_key IN $keys;",
      { keys: [noneKey, presentKey] },
    );
    const buckets = (raw[0] ?? []).map((row) => row.bucket);
    expect(buckets).toContain("ai_allowance_bucket:1");
    expect(buckets.some((value) => value === undefined || value === null)).toBe(true);
  }, 30_000);
});
