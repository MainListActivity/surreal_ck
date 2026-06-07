import { describe, expect, test } from "bun:test";
import { createRootSessionSource } from "./root-connection";

class FakeRootSession {
  signinCalls = 0;

  async query(): Promise<unknown[]> {
    return [];
  }

  async use(): Promise<void> {}

  async closeSession(): Promise<void> {}

  async signin(): Promise<never> {
    this.signinCalls += 1;
    throw new Error("root child sessions must rely on the connection authentication provider");
  }
}

describe("root connection session source", () => {
  test("does not call signin on child sessions so SDK auth provider can renew root auth", async () => {
    const session = new FakeRootSession();
    // 子 session 必须用 forkSession 派生（继承 root 认证态），不能用 newSession
    // （未认证、受 PERMISSIONS 限制看不到数据）。
    const session_factory = {
      forkCalls: 0,
      newSessionCalls: 0,
      async forkSession() {
        this.forkCalls += 1;
        return session;
      },
      async newSession() {
        this.newSessionCalls += 1;
        throw new Error("root child sessions must be derived via forkSession to inherit root auth");
      },
    };
    const source = createRootSessionSource(() => session_factory as never);

    const created = await source.newSession();

    expect(created).toBe(session);
    expect(session.signinCalls).toBe(0);
    expect(session_factory.forkCalls).toBe(1);
    expect(session_factory.newSessionCalls).toBe(0);
  });
});
