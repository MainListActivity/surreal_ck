import { beforeEach, describe, expect, test } from "bun:test";
import type { InviteResult } from "../invitations/invite-service";
import { InviteError } from "../invitations/invite-service";
import type { Queryable } from "../test-subjects/store";
import { TestKitError, TestKitService, type TestKitDeps } from "./service";

const AGENT = { subject: "agent-arch", kind: "agent", capabilities: ["test.provision"] };
const NOW = new Date("2026-11-13T12:00:00Z");
const FUTURE = "2026-12-01T00:00:00Z";
const PAST = "2026-11-01T00:00:00Z";

type Row = Record<string, unknown>;
let testSubjects: Row[];
let workspaces: Row[];
let index: Row[];
let operators: Row[];
let queries: string[];
let invites: Map<string, InviteResult>;
let provisionCalls: Array<{ actor: unknown; input: Record<string, unknown> }>;
let provisionOutcome: (key: string, input: Record<string, unknown>) => InviteResult;
let collected: Set<string>;
let added: unknown[];
let inviteRows: Row[];
let idpEmails: Set<string>;
let dropped: string[];

const db: Queryable = {
  async query(sql, params = {}) {
    queries.push(sql);
    if (sql.includes("FROM test_subject WHERE subject")) return [testSubjects.filter((r) => r.subject === params.subject)];
    if (sql.includes("FROM test_subject WHERE origin")) return [testSubjects.filter((r) => r.origin === params.origin)];
    if (sql.includes("FROM test_subject WHERE email")) return [testSubjects.filter((r) => String(r.email).toLowerCase() === params.email)];
    if (sql.startsWith("INSERT INTO test_subject")) {
      testSubjects.push({ subject: params.subject, email: params.email, expires_at: (params.expiresAt as { toISOString(): string }).toISOString(), origin: params.origin });
      return [[]];
    }
    if (sql.includes("FROM user_workspace_index") && sql.includes("string::lowercase(email)")) return [index.filter((r) => r.email === params.email)];
    if (sql.includes("SELECT VALUE workspace FROM user_workspace_index")) return [index.filter((r) => r.subject === params.subject).map((r) => r.workspace)];
    if (sql.includes("FROM user_workspace_index WHERE workspace = $wid") && !sql.includes("count()")) return [index.filter((r) => r.workspace === String(params.wid))];
    if (sql.includes("FROM workspace WHERE id = $wid")) return [workspaces.filter((w) => w.id === String(params.wid))];
    if (sql.startsWith("SELECT subject FROM test_subject")) return [testSubjects];
    if (sql.includes("count() AS n FROM user_workspace_index")) return [[{ n: index.filter((r) => r.workspace === String(params.wid)).length }]];
    if (sql.includes("FROM user_workspace_index")) return [index.filter((r) => r.subject === params.subject)];
    if (sql.includes("FROM workspace WHERE slug")) {
      const ws = workspaces.filter((w) => w.slug === params.slug);
      return [sql.includes("SELECT VALUE owner_subject") ? ws.map((w) => w.owner_subject) : ws];
    }
    if (sql.includes("FROM ops_invitation")) {
      return [inviteRows.filter((row) => row.status === (sql.includes('"processing"') ? "processing" : "completed")).map((row) => sql.includes("SELECT VALUE") ? row.idempotency_key : row)];
    }
    if (sql.includes("SELECT VALUE id FROM workspace WHERE owner_subject")) return [workspaces.filter((w) => w.owner_subject === params.subject).map((w) => w.id)];
    if (sql.includes("FROM platform_operator")) return [operators.filter((r) => r.subject === params.subject)];
    if (sql.startsWith("UPDATE $wid")) {
      const ws = workspaces.find((w) => w.id === String(params.wid));
      if (ws) ws.test_expires_at = (params.expiresAt as { toISOString(): string }).toISOString();
      return [[]];
    }
    return [[]];
  },
};

const completed = (key: string, email: string, outcome: "created" | "reused" = "created"): InviteResult => ({
  idempotencyKey: key,
  status: "completed",
  replayed: false,
  user: { id: `sub-${email}`, email, status: "pending", outcome },
  workspace: { slug: "kit-b", dbName: "ws_kit_b", outcome: "created" },
  entitlement: null,
  aiAllowance: null,
  delivery: { channel: "activation_url", activationUrl: "https://auth.example/activate?t=once", pendingCollect: false, note: "" },
} as unknown as InviteResult);

function service(extra: Partial<TestKitDeps> = {}) {
  return new TestKitService({
    invites: {
      async provision(actor, input) {
        provisionCalls.push({ actor, input: input as unknown as Record<string, unknown> });
        const result = provisionOutcome(input.idempotencyKey, input as unknown as Record<string, unknown>);
        invites.set(input.idempotencyKey, { ...result, delivery: { ...result.delivery, activationUrl: null } } as InviteResult);
        if (result.status === "completed" && result.user) {
          // 代办开通建出的 workspace 与成员索引（唯一成员 → 预检会标记）
          workspaces.push({ id: "workspace:kitb", slug: input.workspaceSlug, owner_subject: result.user.id, db_name: "ws_kit_b" });
          index.push({ subject: result.user.id, workspace: "workspace:kitb", email: input.email, role: "owner" });
        }
        return result;
      },
      async get(key) { return invites.get(key) ?? null; },
      async collect(key) {
        const first = !collected.has(key);
        collected.add(key);
        return { idempotencyKey: key, status: "completed", activationUrl: first ? "https://auth.example/activate?t=late" : null, deliveredAt: null, errorCode: null, errorMessage: null };
      },
    },
    members: { async addMember(input) { added.push(input); return { kind: "added" }; } },
    getSystemDb: async () => db,
    idpUserExists: async (email) => idpEmails.has(email),
    reaperDeps: async () => ({ systemDb: db, testSubjects: testSubjects.map((t) => String(t.subject)), dropDatabase: async (name: string) => { dropped.push(name); }, now: () => NOW, log: () => {} }) as never,
    emailPattern: "yyx6953119\\+[a-z0-9-]+@gmail\\.com",
    maxActive: 2,
    now: () => NOW,
    ...extra,
  });
}

const provisionArgs = (over: Record<string, unknown> = {}) => ({
  email: "yyx6953119+kit-b@gmail.com", displayName: "测试 B", workspaceSlug: "kit-b", idempotencyKey: "b1", ...over,
});

async function rejects(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof TestKitError) return error.code; throw error; }
  throw new Error("expected rejection");
}

beforeEach(() => {
  testSubjects = []; workspaces = []; index = []; operators = []; queries = [];
  invites = new Map(); provisionCalls = []; collected = new Set(); added = []; inviteRows = []; idpEmails = new Set(); dropped = [];
  provisionOutcome = (key, input) => completed(key, String(input.email));
});

describe("test kit provision", () => {
  test("opens a trial account, registers it as this agent's 30-day test subject and returns the link once", async () => {
    const out = await service().provision(AGENT, provisionArgs()) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "completed", idempotencyKey: "b1", email: "yyx6953119+kit-b@gmail.com", activationUrl: "https://auth.example/activate?t=once" });
    expect(provisionCalls[0]!.input).toMatchObject({ planKey: "trial", quotaPlanRevisionId: "quota_plan_revision:trial_v2", idempotencyKey: "test-kit:agent-arch:b1" });
    // 额度到期按 UTC 日取整（同日重发摘要一致）
    expect((provisionCalls[0]!.input.aiAllowance as { expiresAt: string }).expiresAt).toBe("2026-12-14T00:00:00.000Z");
    expect((provisionCalls[0]!.input.aiAllowance as { amount: number }).amount).toBe(100);
    expect(testSubjects).toHaveLength(1);
    expect(testSubjects[0]).toMatchObject({ origin: "test-kit:agent-arch", expires_at: "2026-12-13T12:00:00.000Z" });
    expect(workspaces[0]!.test_expires_at).toBe("2026-12-13T12:00:00.000Z");
  });

  test("replaying the same key does not provision again and does not re-issue the link", async () => {
    const kit = service();
    await kit.provision(AGENT, provisionArgs());
    const again = await kit.provision(AGENT, provisionArgs()) as Record<string, unknown>;
    expect(provisionCalls).toHaveLength(1);
    expect(again.activationUrl).toBeNull();
    expect(testSubjects).toHaveLength(1);
  });

  test("emails outside the pattern, or with the tool disabled, never reach the invite service", async () => {
    expect(await rejects(service().provision(AGENT, provisionArgs({ email: "someone@gmail.com" })))).toBe("email_not_allowed");
    expect(await rejects(service().provision(AGENT, provisionArgs({ email: "yyx6953119+x@gmail.com.evil.com" })))).toBe("email_not_allowed");
    expect(await rejects(service({ emailPattern: undefined }).provision(AGENT, provisionArgs()))).toBe("disabled");
    expect(provisionCalls).toHaveLength(0);
  });

  test("requires test.provision in the effective capabilities", async () => {
    expect(await rejects(service().provision({ ...AGENT, capabilities: [] }, provisionArgs()))).toBe("forbidden");
    expect(await rejects(service().list({ ...AGENT, capabilities: ["test.manage"] }))).toBe("forbidden");
  });

  test("an email already known to the product is refused before provisioning", async () => {
    index.push({ subject: "real-user", email: "yyx6953119+kit-b@gmail.com", workspace: "workspace:real" });
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("email_in_use");
    expect(provisionCalls).toHaveLength(0);
  });

  test("an IdP account that already existed is never registered as a test subject", async () => {
    provisionOutcome = (key, input) => completed(key, String(input.email), "reused");
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("email_in_use");
    expect(testSubjects).toHaveLength(0);
  });

  test("slug taken and active cap are enforced", async () => {
    workspaces.push({ id: "workspace:x", slug: "kit-b", owner_subject: "other" });
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("slug_taken");
    workspaces = [];
    testSubjects.push({ subject: "s1", origin: "test-kit:agent-arch", expires_at: FUTURE }, { subject: "s2", origin: "test-kit:agent-arch", expires_at: FUTURE });
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("limit_reached");
    testSubjects[1]!.expires_at = PAST;
    expect((await service().provision(AGENT, provisionArgs()) as Record<string, unknown>).status).toBe("completed");
  });

  test("a slow provision is finished by status, which registers and collects the link once", async () => {
    provisionOutcome = (key) => ({ idempotencyKey: key, status: "processing", replayed: false, user: null, workspace: null, entitlement: null, aiAllowance: null, delivery: { channel: "none", activationUrl: null, pendingCollect: false, note: "" } } as unknown as InviteResult);
    const kit = service();
    expect((await kit.provision(AGENT, provisionArgs()) as Record<string, unknown>).status).toBe("processing");
    expect(testSubjects).toHaveLength(0);
    workspaces.push({ id: "workspace:kitb", slug: "kit-b", owner_subject: "sub-yyx6953119+kit-b@gmail.com" });
    invites.set("test-kit:agent-arch:b1", { ...completed("test-kit:agent-arch:b1", "yyx6953119+kit-b@gmail.com"), delivery: { channel: "activation_url", activationUrl: null, pendingCollect: true, note: "" } } as InviteResult);
    const first = await kit.status(AGENT, { idempotencyKey: "b1" });
    expect(first).toMatchObject({ status: "completed", activationUrl: "https://auth.example/activate?t=late" });
    expect(testSubjects).toHaveLength(1);
    expect((await kit.status(AGENT, { idempotencyKey: "b1" })).activationUrl).toBeNull();
  });

  test("another agent cannot read my provision by key", async () => {
    await service().provision(AGENT, provisionArgs());
    expect(await rejects(service().status({ ...AGENT, subject: "agent-other" }, { idempotencyKey: "b1" }))).toBe("not_found");
  });

  test("an email the IdP already knows (e.g. a purged test account) is refused before provisioning", async () => {
    idpEmails.add("yyx6953119+kit-b@gmail.com");
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("email_in_use");
    expect(provisionCalls).toHaveLength(0);
  });

  test("in-flight provisions count toward the cap", async () => {
    testSubjects.push({ subject: "s1", origin: "test-kit:agent-arch", expires_at: FUTURE });
    inviteRows.push({ idempotency_key: "test-kit:agent-arch:slow", status: "processing", email: "x" });
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("limit_reached");
  });

  test("a processing key is re-sent so a stale provision can resume, skipping the fresh-account checks", async () => {
    invites.set("test-kit:agent-arch:b1", { idempotencyKey: "test-kit:agent-arch:b1", status: "processing", user: null } as unknown as InviteResult);
    idpEmails.add("yyx6953119+kit-b@gmail.com"); // 上一轮已建出的 IdP 用户
    const out = await service().provision(AGENT, provisionArgs()) as Record<string, unknown>;
    expect(provisionCalls).toHaveLength(1);
    expect(out.status).toBe("completed");
  });

  test("a completed but never-polled provision is registered on list", async () => {
    workspaces.push({ id: "workspace:late", slug: "kit-b", owner_subject: "sub-late@x" });
    index.push({ subject: "sub-late@x", workspace: "workspace:late", role: "owner" });
    inviteRows.push({ idempotency_key: "test-kit:agent-arch:late", status: "completed" });
    invites.set("test-kit:agent-arch:late", completed("test-kit:agent-arch:late", "late@x"));
    const out = await service().list(AGENT);
    expect(out.subjects.map((s) => s.subject)).toEqual(["sub-late@x"]);
  });

  test("a purged account is not resurrected by a later status call", async () => {
    invites.set("test-kit:agent-arch:gone", completed("test-kit:agent-arch:gone", "gone@x"));
    expect((await service().status(AGENT, { idempotencyKey: "gone" })).status).toBe("purged");
    expect(testSubjects).toHaveLength(0);
  });

  test("invite errors surface as tool errors", async () => {
    provisionOutcome = () => { throw new InviteError("invite-slug-taken", "taken"); };
    expect(await rejects(service().provision(AGENT, provisionArgs()))).toBe("invite-slug-taken");
  });
});

describe("test kit members, list and purge", () => {
  beforeEach(() => {
    testSubjects.push(
      { subject: "sub-a", email: "yyx6953119+a@gmail.com", expires_at: FUTURE, origin: "ops" },
      { subject: "sub-b", email: "yyx6953119+b@gmail.com", expires_at: FUTURE, origin: "test-kit:agent-arch" },
    );
    workspaces.push(
      { id: "workspace:a", slug: "signal-test-1113", owner_subject: "sub-a", test_expires_at: FUTURE },
      { id: "workspace:real", slug: "real-team", owner_subject: "real-user" },
    );
    index.push({ subject: "sub-b", workspace: "workspace:b", role: "owner" });
  });

  test("adds a test account to a test-owned workspace through the owner", async () => {
    const out = await service().addMember(AGENT, { workspaceSlug: "signal-test-1113", email: "YYX6953119+b@gmail.com" });
    expect(out).toMatchObject({ added: true, role: "participant" });
    expect(added[0]).toMatchObject({ callerSubject: "sub-a", slug: "signal-test-1113", email: "yyx6953119+b@gmail.com", isAdmin: false });
  });

  test("refuses real workspaces and non-test members", async () => {
    expect(await rejects(service().addMember(AGENT, { workspaceSlug: "real-team", email: "yyx6953119+b@gmail.com" }))).toBe("not_test_workspace");
    expect(await rejects(service().addMember(AGENT, { workspaceSlug: "signal-test-1113", email: "someone@gmail.com" }))).toBe("not_test_subject");
    testSubjects[1]!.expires_at = PAST;
    expect(await rejects(service().addMember(AGENT, { workspaceSlug: "signal-test-1113", email: "yyx6953119+b@gmail.com" }))).toBe("not_test_subject");
    expect(added).toHaveLength(0);
  });

  test("list shows only my accounts", async () => {
    const out = await service().list(AGENT);
    expect(out.subjects.map((s) => s.subject)).toEqual(["sub-b"]);
    expect(out.subjects[0]).toMatchObject({ expired: false, workspaces: [{ slug: null, role: "owner" }] });
  });

  test("purging a member drops only workspaces it owns, never the shared test workspace it joined", async () => {
    workspaces.push({ id: "workspace:b", slug: "kit-b", owner_subject: "sub-b", db_name: "ws_kit_b" });
    index.push({ subject: "sub-b", workspace: "workspace:a", role: "participant" }, { subject: "sub-a", workspace: "workspace:a", role: "owner" });
    const out = await service().purge(AGENT, { subject: "sub-b", confirm: "purge sub-b" });
    expect(out).toMatchObject({ workspacesPurged: 1, workspacesSkipped: 0 });
    expect(dropped).toEqual(["ws_kit_b"]);
  });

  test("purge needs the confirm phrase and only touches my accounts", async () => {
    expect(await rejects(service().purge(AGENT, { subject: "sub-b" }))).toBe("confirmation_required");
    expect(await rejects(service().purge(AGENT, { subject: "sub-a", confirm: "purge sub-a" }))).toBe("not_owned");
    expect(queries.some((q) => q.includes("SELECT VALUE workspace FROM user_workspace_index"))).toBe(false);
  });
});

describe("test kit rules", () => {
  test("reports the limits the tools enforce", () => {
    expect(service().rules(AGENT)).toMatchObject({ enabled: true, maxActive: 2, ttlDays: 30, plan: "trial", aiAllowance: 100, origin: "test-kit:agent-arch" });
    expect(service({ emailPattern: "(" }).rules(AGENT).enabled).toBe(false);
  });
});
