// 入参校验与授权门（不触库）。开通/续跑/对账/清理流程在 service.integration.test.ts 里
// 用真实 SurrealDB 与真实 InviteService 覆盖（RUN_LOCAL_SURREALDB_TEST_SUBJECT_TESTS=1）。
import { describe, expect, test } from "bun:test";
import { TestKitError, TestKitService, type TestKitDeps } from "./service";

const AGENT = { subject: "agent-arch", kind: "agent", capabilities: ["test.provision"] };
let touched: string[] = [];

function service(extra: Partial<TestKitDeps> = {}) {
  touched = [];
  const note = (what: string) => async () => { touched.push(what); throw new Error(`unexpected ${what}`); };
  return new TestKitService({
    invites: { provision: note("provision"), get: note("get"), collect: note("collect") } as never,
    members: { addMember: note("addMember") } as never,
    getSystemDb: note("db") as never,
    idpFindUser: note("idp") as never,
    reaperDeps: note("reaper") as never,
    emailPattern: "yyx6953119[+][a-z0-9-]+@gmail[.]com",
    ...extra,
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof TestKitError) return error.code; throw error; }
  throw new Error("expected rejection");
}

const args = (over: Record<string, unknown> = {}) => ({ email: "yyx6953119+kit-b@gmail.com", displayName: "B", workspaceSlug: "kit-b", ...over });

describe("test kit gates", () => {
  test("every tool requires test.provision in the effective capabilities", async () => {
    const none = { ...AGENT, capabilities: ["test.manage"] };
    const kit = service();
    expect(() => kit.rules(none)).toThrow(TestKitError);
    expect(await code(kit.provision(none, args()))).toBe("forbidden");
    expect(await code(kit.status(none, { email: "x" }))).toBe("forbidden");
    expect(await code(kit.list(none))).toBe("forbidden");
    expect(await code(kit.addMember(none, { workspaceSlug: "a", email: "x" }))).toBe("forbidden");
    expect(await code(kit.purge(none, { subject: "s", confirm: "purge s" }))).toBe("forbidden");
    expect(touched).toEqual([]);
  });

  test("emails must fully match the pattern; no pattern means disabled; nothing is touched", async () => {
    expect(await code(service().provision(AGENT, args({ email: "someone@gmail.com" })))).toBe("email_not_allowed");
    expect(await code(service().provision(AGENT, args({ email: "yyx6953119+x@gmail.com.evil.com" })))).toBe("email_not_allowed");
    expect(await code(service({ emailPattern: undefined }).provision(AGENT, args()))).toBe("disabled");
    expect(await code(service({ emailPattern: "(" }).provision(AGENT, args()))).toBe("disabled");
    expect(touched).toEqual([]);
  });

  test("purge requires the exact confirm phrase before touching anything", async () => {
    expect(await code(service().purge(AGENT, { subject: "sub-b" }))).toBe("confirmation_required");
    expect(await code(service().purge(AGENT, { subject: "sub-b", confirm: "purge sub-c" }))).toBe("confirmation_required");
    expect(touched).toEqual([]);
  });

  test("rules report the enforced limits", () => {
    expect(service({ maxActive: 3 }).rules(AGENT)).toMatchObject({ enabled: true, maxActive: 3, ttlDays: 30, plan: "trial", aiAllowance: 100, origin: "test-kit:agent-arch" });
    expect(service({ emailPattern: undefined }).rules(AGENT).enabled).toBe(false);
  });
});
