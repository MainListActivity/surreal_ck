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
    const source = createRootSessionSource(
      () =>
        ({
          async newSession() {
            return session;
          },
        }) as never,
    );

    const created = await source.newSession();

    expect(created).toBe(session);
    expect(session.signinCalls).toBe(0);
  });
});
