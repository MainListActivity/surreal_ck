import { expect, test } from "bun:test";
import { Hono } from "hono";
import { PUBLIC_ACTION, TRIAL_PATH } from "@surreal-ck/shared/public-entry";
import edge from "../../../cloudflare/edge-proxy";
import { HttpError } from "../http-error";
import { handleError } from "../middleware/error";
import { createTrialRequestRoutes, trialRequestCors } from "../routes/trial-request";
import { createPublicProtection, createSiteverify } from "./protection";

test("Siteverify 校验 action、hostname、失败和并发重放", async () => {
  const good = { success: true, hostname: "app.example", action: PUBLIC_ACTION.roster };
  const fixtures = [
    Response.json(good),
    Response.json({ ...good, hostname: "other.example" }),
    Response.json({ ...good, action: PUBLIC_ACTION.guest }),
    Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    new Response("upstream error", { status: 503 }),
  ];
  const request = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(init?.body)).toContain("remoteip=192.0.2.1");
    return fixtures.shift()!;
  }, { preconnect: fetch.preconnect });
  const verify = createSiteverify("fixture", ["app.example"], request);
  const check = (token: unknown) => verify(token, PUBLIC_ACTION.roster, "192.0.2.1");
  expect(await check(null)).toBe(false);
  expect(await check("x".repeat(2049))).toBe(false);
  expect(await Promise.all([check("valid"), check("valid")])).toEqual([true, false]);
  for (const token of ["hostname", "action", "expired", "fake", "upstream"]) expect(await check(token)).toBe(false);
  expect(fixtures).toHaveLength(0);
  expect(await createSiteverify(undefined, ["app.example"], request)("token", PUBLIC_ACTION.roster, "192.0.2.1")).toBe(false);
});

test("源站目标预算在业务处理前拒绝请求，窗口过期后恢复", async () => {
  let processed = 0;
  let source = "source";
  let time = 0;
  const protection = createPublicProtection({ enabled: true, verify: async () => true, source: () => source, now: () => time });
  const path = "/api/meeting/roster/verify";
  const app = new Hono().post(path, async c =>
    await protection.challenge(c, PUBLIC_ACTION.roster, "opaque", "fixture", () => new HttpError(401, "denied", "凭证无效"))
    ?? c.json({ hits: ++processed }));
  for (let i = 0; i < 8; i++) expect((await app.request(path, { method: "POST" })).status).toBe(200);
  source = "alternate";
  const limit = await app.request(path, { method: "POST" });
  expect(limit.status).toBe(429);
  expect(limit.headers.get("retry-after")).toBe("60");
  expect(processed).toBe(8);
  time = 60_000;
  expect((await app.request(path, { method: "POST" })).status).toBe(200);
});

test("边缘超限先于 origin 转发，预算键不含邀请凭证", async () => {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => {
    keys.push(key);
    return { success: false };
  } };
  const env = {
    ORIGIN_BASE_URL: "https://origin.example",
    EDGE_PROXY_SECRET: "fixture",
    PUBLIC_ENTRY_LIMIT: limiter,
    PUBLIC_MEETING_LIMIT: limiter,
  };
  for (const path of [
    "/api/claims-portal/workspace/private-token/session",
    "/api/meeting/roster/verify",
  ]) {
    const request = new Request("https://app.example" + path, {
      method: "POST", headers: { "cf-connecting-ip": "192.0.2.1" },
    });
    const response = await edge.fetch(request, env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  }
  expect(keys).toEqual(["claims:192.0.2.1", "roster:192.0.2.1"]);

});

test("试用申请仅在通过校验后转发，联系人放入联系字段", async () => {
  const origin = "https://www.example";
  const sent: Array<Record<string, unknown>> = [];
  const request = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { id: "a".repeat(64) } }, { status: 202 });
  }, { preconnect: fetch.preconnect });
  const protection = createPublicProtection({ enabled: true, verify: async token => token === "verified" });
  const app = new Hono().onError(handleError).use(TRIAL_PATH, trialRequestCors(origin))
    .route("/", createTrialRequestRoutes({ origin, feedbackUrl: "https://feedback.example/api/feedback/test", request, protection }));
  const data = { organization: "测试机构", name: "张三", contact: "contact@example.test",
    scenes: ["债权人会议"], requestKey: crypto.randomUUID() };
  const submit = (fields: object) => app.request(TRIAL_PATH, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(fields),
  });
  expect((await submit(data)).status).toBe(403);
  expect((await submit({ ...data, name: "测".repeat(51), turnstileToken: "verified" })).status).toBe(400);
  expect(sent).toHaveLength(0);
  const response = await submit({ ...data, turnstileToken: "verified" });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ receipt: "a".repeat(64) });
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(sent).toEqual([{
    requestKey: data.requestKey, text: "官网试用申请\n机构：测试机构\n场景：债权人会议",
    page: "https://www.example/trial/", contact: "联系人：张三\n联系方式：contact@example.test",
  }]);
});
