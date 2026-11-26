import { expect, test } from "bun:test";
import { Hono } from "hono";
import { RosterMeetingService } from "../meeting/roster";
import { handleError } from "../middleware/error";
import { createMeetingRosterRoutes } from "./meeting-roster";

const site = "https://meeting.test";
const pepper = "x".repeat(32);
const path = "/api/workspaces/fixture/roster-meetings";
const guest = "/api/meeting/roster";
function fixture(value: string | undefined, proxy = false) {
  const service = new RosterMeetingService({
    getPepper: () => value,
    resolveWorkspace: async (slug) => slug === "fixture" ? { dbName: "ws_fixture" } : null,
    getSession: async () => ({ query: async () => [[]] }),
  });
  return new Hono().onError(handleError).route("/", createMeetingRosterRoutes({
    service, origin: site, trustedProxy: proxy, requireUser: () => async (c, next) => {
      c.set("user", { subject: "fixture", rawToken: "", raw: {
        db: c.req.header("workspace") ?? "ws_fixture", ac: c.req.header("access") ?? "admin",
      } });
      await next();
    },
  }));
}

test("名册会议列表仅对目标工作区的管理员开放；空列表可读，未配置时返回 503", async () => {
  const app = fixture(pepper);
  for (const relative of ["", "/roster_meeting:a/passes"]) {
    expect((await app.request(path + relative, { headers: { access: "participant" } })).status).toBe(403);
    expect((await app.request(path + relative, { headers: { workspace: "ws_other" } })).status).toBe(403);
  }
  const res = await app.request(path);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ meetings: [] });
  expect((await fixture(undefined).request(path)).status).toBe(503);
});

test("公开错误统一、校验 Origin；仅在配置后信任代理的来源地址", async () => {
  const verify = (app: ReturnType<typeof fixture>, pass: string, ip = "192.0.2.1", origin = site) =>
    app.request(guest + "/verify", {
      method: "POST", headers: { Origin: origin, "CF-Connecting-IP": ip }, body: JSON.stringify({ pass, code: "000000" }),
    });
  const app = fixture(pepper);
  const first = await verify(app, "unknown");
  const denied = { error: { code: "meeting-roster-denied", message: "无法验证参会凭证" } };
  expect(first.status).toBe(401);
  expect(await first.json()).toEqual(denied);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  expect(await (await verify(app, "unknown", "192.0.2.1", "https://other.test")).json()).toEqual(denied);
  expect((await app.request(guest + "/session")).status).toBe(401);
  for (let i = 0; i < 4; i++) expect((await verify(app, "unknown")).status).toBe(401);
  expect((await verify(app, "unknown")).status).toBe(429);
  for (let i = 0; i < 24; i++) expect((await verify(app, `unknown${i}`, `192.0.2.${i + 2}`)).status).toBe(401);
  expect((await verify(app, "another", "192.0.2.100")).status).toBe(429);
  const trusted = fixture(pepper, true);
  for (let i = 0; i < 31; i++) expect((await verify(trusted, `unknown${i}`, `198.51.100.${i + 1}`)).status).toBe(401);
});
