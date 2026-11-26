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
