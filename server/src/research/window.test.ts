import { describe, expect, test } from "bun:test";
import { createContentResearchSessionFactory } from "./window";
import type { ContentSearchExchangeSuccess } from "@surreal-ck/shared";

const caller = {
  subject: "human-1",
  email: "human@example.com",
  raw: { db: "ws_demo", exp: Math.floor(Date.now() / 1000) + 600 } as Record<string, unknown>,
  rawToken: "caller-token",
};

function readyExchange(): ContentSearchExchangeSuccess {
  return {
    status: "ready",
    contractId: "content_reader.v1",
    tokenType: "Bearer",
    accessToken: "lease-token",
    expiresInSeconds: 600,
    namespace: "main",
    database: "platform_content",
    workspaceId: "ws_demo",
    entitlementRevision: "7",
    digest: "sha256:abc",
    leaseEndSeconds: Math.floor(Date.now() / 1000) + 600,
  };
}

describe("createContentResearchSessionFactory", () => {
  test("ready：租约 token 在服务端建立会话并绑定权益修订", async () => {
    const connected: Array<{ url: string; namespace: string; database: string; token?: string }> = [];
    const closed: string[] = [];
    const factory = createContentResearchSessionFactory({
      searchExchange: (async () => readyExchange()) as never,
      openSession: () => ({
        connect(url: string, options: { namespace: string; database: string }) {
          connected.push({ url, ...options });
          return Promise.resolve();
        },
        authenticate(token: string) {
          connected[connected.length - 1]!.token = token;
          return Promise.resolve();
        },
        close() {
          closed.push("session");
          return Promise.resolve();
        },
        query: (() => Promise.resolve([[]])) as never,
      }),
    });

    const window = await factory(caller);
    expect(window.kind).toBe("ready");
    if (window.kind !== "ready") return;
    expect(window.entitlementRevision).toBe("7");
    expect(window.digest).toBe("sha256:abc");
    expect(connected[0]).toMatchObject({ namespace: "main", database: "platform_content", token: "lease-token" });
    await window.close();
    expect(closed).toEqual(["session"]);
  });

  test("exchange 拒绝（无授权/无成员等）归一为 unavailable", async () => {
    const factory = createContentResearchSessionFactory({
      searchExchange: (async () => ({ ok: false, error: "entitlement_absent" })) as never,
    });
    const window = await factory(caller);
    expect(window).toEqual({ kind: "unavailable", reason: "entitlement_absent" });
  });

  test("exchange empty（无可授权集合）保持 empty 状态", async () => {
    const factory = createContentResearchSessionFactory({
      searchExchange: (async () => ({ status: "empty" })) as never,
    });
    const window = await factory(caller);
    expect(window).toEqual({ kind: "empty" });
  });

  test("exchange 抛错或连接失败都是 platform_error，不外泄细节", async () => {
    const throwing = createContentResearchSessionFactory({
      searchExchange: (async () => {
        throw new Error("projection detail leak");
      }) as never,
    });
    expect(await throwing(caller)).toEqual({ kind: "unavailable", reason: "platform_error" });

    const connectFail = createContentResearchSessionFactory({
      searchExchange: (async () => readyExchange()) as never,
      openSession: () => ({
        connect: () => Promise.reject(new Error("connect refused")),
        authenticate: () => Promise.resolve(),
        close: () => Promise.resolve(),
        query: (() => Promise.resolve([[]])) as never,
      }),
    });
    expect(await connectFail(caller)).toEqual({ kind: "unavailable", reason: "platform_error" });
  });
});
