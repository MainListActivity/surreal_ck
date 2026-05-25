import { describe, expect, test } from "bun:test";
import { createCallerSession } from "./caller-session";

type FakeSurreal = {
  connected: boolean;
  authenticatedWith?: string;
  used?: { namespace?: string; database?: string };
  connect(url: string): Promise<void>;
  authenticate(token: string): Promise<true>;
  use(opts: { namespace?: string; database?: string }): Promise<void>;
};

function fakeSurreal(opts: { authThrows?: boolean } = {}): FakeSurreal {
  return {
    connected: false,
    async connect() {
      this.connected = true;
    },
    async authenticate(token: string) {
      if (opts.authThrows) throw new Error("There was a problem with authentication");
      this.authenticatedWith = token;
      return true;
    },
    async use(o) {
      this.used = o;
    },
  };
}

describe("createCallerSession", () => {
  test("connect 后用 OIDC token authenticate，得到调用者会话", async () => {
    const fake = fakeSurreal();
    const session = await createCallerSession("oidc-token-xyz", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
    });

    expect(session).toBe(fake as never);
    expect(fake.connected).toBe(true);
    expect(fake.authenticatedWith).toBe("oidc-token-xyz");
    // 不 use()：JWT token 自带 db/ac scope，authenticate 已把会话落到目标 db。
    expect(fake.used).toBeUndefined();
  });

  test("authenticate 被 DB 引擎拒绝时向上抛（由路由翻成 403）", async () => {
    const fake = fakeSurreal({ authThrows: true });
    await expect(
      createCallerSession("bad-token", { surrealUrl: "ws://db/rpc", newSurreal: () => fake as never }),
    ).rejects.toThrow(/authentication/i);
  });
});
