import { expect, test } from "bun:test";
import { createPublicRosterApi, rosterExitMessage, rosterVerifyMessage, RosterRequestError } from "./roster";

test("公开客户端同源使用 Cookie，不发送登录或数据库凭证", async () => {
  const seen: { input: unknown; init?: RequestInit }[] = [];
  const fetcher = Object.assign(async (input: unknown, init?: RequestInit) => {
    seen.push({ input, init });
    return Response.json({ state: "waiting", title: "名册会议", name: "示例" });
  }, { preconnect: () => {} });
  const api = createPublicRosterApi(fetcher);
  expect((await api.verify("pass-fixture", "123456")).state).toBe("waiting");
  await api.session();
  await api.credentials();
  expect(seen.map(({ input, init }) => [input, init?.method])).toEqual([
    ["/api/meeting/roster/verify", "POST"], ["/api/meeting/roster/session", "GET"], ["/api/meeting/roster/credentials", "POST"],
  ]);
  expect(seen[0]?.init?.body).toBe(JSON.stringify({ pass: "pass-fixture", code: "123456" }));
  for (const { init } of seen) {
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  }
});

test("终止状态和核验错误文案不会暴露原因", async () => {
  expect(rosterExitMessage("waiting")).toBe("");
  expect(rosterExitMessage("admitted")).toBe("");
  expect(rosterExitMessage("replaced")).toBe("您的参会凭证已在其他设备登录，本端已下线");
  expect(rosterExitMessage("kicked")).toBe("您已被移出会议");
  expect(rosterExitMessage("revoked")).toBe("您已被移出会议");
  const api = createPublicRosterApi(Object.assign(async () => new Response("", { status: 429 }), { preconnect: () => {} }));
  await expect(api.verify("", "")).rejects.toMatchObject({ status: 429 });
  expect(rosterVerifyMessage(new RosterRequestError(429, ""))).toBe("尝试次数过多，请稍后再试");
  expect(rosterVerifyMessage(new RosterRequestError(401, "不应显示"))).toBe("无法验证参会凭证");
});
