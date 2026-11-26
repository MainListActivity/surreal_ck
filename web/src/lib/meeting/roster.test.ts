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

test("名册表决沿用 Cookie，并以 PDF 原样下载个人回执", async () => {
  const seen: { path: unknown; init?: RequestInit }[] = [];
  const ballot = { option: "no", note: "保留意见", at: "2026-11-26T00:00:00Z" };
  const api = createPublicRosterApi(Object.assign(async (path: unknown, init?: RequestInit) => {
    seen.push({ path, init });
    if (init?.method === "POST") return Response.json(ballot);
    if (String(path).endsWith(".pdf")) return new Response("%PDF", { headers: { "Content-Type": "application/pdf" } });
    return Response.json({ polls: [] });
  }, { preconnect: () => {} }));
  const vote = { option: "no", note: "保留意见", requestId: "4fede346-5465-4e77-826a-c697f7b76638" };
  expect(await api.polls()).toEqual([]);
  expect(await api.vote("poll:a/b", vote)).toEqual(ballot);
  const file = await api.receipt("poll:a/b");
  expect(file.type).toBe("application/pdf");
  expect(await file.text()).toBe("%PDF");
  expect(seen.map(({ path, init }) => [path, init?.method])).toEqual([
    ["/api/meeting/roster/polls", "GET"],
    ["/api/meeting/roster/polls/poll%3Aa%2Fb/vote", "POST"],
    ["/api/meeting/roster/polls/poll%3Aa%2Fb/receipt.pdf", "GET"],
  ]);
  expect(seen[1]?.init?.body).toBe(JSON.stringify(vote));
  expect(seen[2]?.init?.credentials).toBe("include");
  for (const { init } of seen) expect(new Headers(init?.headers).has("Authorization")).toBe(false);
});
