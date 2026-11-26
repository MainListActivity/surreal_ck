import { expect, test } from "bun:test";
import { createRosterAdminApi } from "./roster-admin";

test("管理员客户端使用访问令牌并安全编码路径，CSV 不作为 JSON 读取", async () => {
  const requests: { path: unknown; options?: RequestInit }[] = [];
  const api = createRosterAdminApi("fixture", async () => "fixture-token", Object.assign(async (path: unknown, options?: RequestInit) => {
    requests.push({ path, options });
    return requests.length === 1 ? Response.json({ meetings: [] }) : new Response("CSV");
  }, { preconnect: () => {} }));
  expect(await api.list()).toEqual([]);
  expect(await (await api.issue("roster_meeting:a", ["ent_fixture:b"])).text()).toBe("CSV");
  expect(requests[1]?.path).toBe("/api/workspaces/fixture/roster-meetings/roster_meeting%3Aa/passes");
  expect(requests[1]?.options?.body).toBe(JSON.stringify({ row_ids: ["ent_fixture:b"] }));
  expect(requests[1]?.options?.credentials).toBe("omit");
  expect(new Headers(requests[1]?.options?.headers).get("Authorization")).toBe("Bearer fixture-token");
  await expect(createRosterAdminApi("fixture", async () => null).list()).rejects.toMatchObject({ status: 401 });
});

test("主持人客户端按会议读写表决与归档配置", async () => {
  const requests: { path: unknown; init?: RequestInit }[] = [];
  const targets = { attendanceSheet: "sheet:a", voteSheet: "sheet:b" };
  const config = { ...targets, weightField: "score" };
  const poll = { title: "议题", options: [{ key: "yes", label: "同意" }], allowChange: true, deadline: "2026-11-26T00:00:00Z" };
  const api = createRosterAdminApi("例", async () => "fixture-token", Object.assign(async (path: unknown, init?: RequestInit) => {
    requests.push({ path, init });
    if (init?.method === "PUT" || (init?.method === "POST" && String(path).endsWith("/polls"))) return new Response(null, { status: 204 });
    if (String(path).endsWith("/polls")) return Response.json({ polls: [] });
    if (String(path).endsWith("/archive")) return Response.json(targets);
    return Response.json({ ...config, defaults: { agenda: [poll] } });
  }, { preconnect: () => {} }));
  expect(await api.polls("roster_meeting:a")).toEqual([]);
  await api.createPoll("roster_meeting:a", poll);
  expect(await api.archiveConfig("roster_meeting:a")).toMatchObject(config);
  await api.saveArchiveConfig("roster_meeting:a", config);
  expect(await api.archive("roster_meeting:a")).toEqual(targets);
  const base = "/api/workspaces/%E4%BE%8B/roster-meetings/roster_meeting%3Aa";
  expect(requests.map(({ path, init }) => [path, init?.method])).toEqual([
    [base + "/polls", "GET"], [base + "/polls", "POST"], [base + "/archive-config", "GET"],
    [base + "/archive-config", "PUT"], [base + "/archive", "POST"],
  ]);
  expect(requests[1]?.init?.body).toBe(JSON.stringify(poll));
  expect(requests[3]?.init?.body).toBe(JSON.stringify(config));
});

test("存证下载使用同工作区的单次票据并将响应体交给流式保存", async () => {
  const path = "/api/workspaces/fixture/roster-meetings/roster_meeting%3Aa/evidence";
  const content = new Response("tar");
  const requests: [string, string | undefined][] = [];
  const api = createRosterAdminApi("fixture", async () => "fixture-token", Object.assign(async (url: unknown, init?: RequestInit) => {
    requests.push([String(url), init?.method]);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
    return init?.method === "POST" ? Response.json({ url: path + "/download?ticket=fixture" }) : content;
  }, { preconnect: () => {} }));
  expect(await api.downloadEvidence("roster_meeting:a")).toBe(content);
  expect(content.bodyUsed).toBe(false);
  expect(requests).toEqual([[path + "/grant", "POST"], [path + "/download?ticket=fixture", "GET"]]);
});
