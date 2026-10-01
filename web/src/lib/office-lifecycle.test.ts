import { describe, expect, test } from "bun:test";
import { createOfficeLifecycleClient } from "./office-lifecycle";

/**
 * b09c87b1 QA 退回回归：hc client 路由根键是 `api`（服务端业务路由挂在 `/api`），
 * 少了这一层请求发到 `/workspaces/...` 而非 `/api/workspaces/...`，生产 405。
 * 这里用记录属性访问链的 Proxy 断言工厂从 `.api` 起走，并核对 param 透传。
 */

type Seg = string;

/** 记录属性访问链的递归 Proxy：模拟 hc 的动态路由段。 */
function recordingRoute(seen: Seg[], post: (input: unknown) => Promise<unknown>) {
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, key) => {
        const seg = String(key);
        seen.push(seg);
        return seg === "$post" ? post : proxy;
      },
    },
  );
  return proxy;
}

describe("createOfficeLifecycleClient — /api 前缀回归（b09c87b1）", () => {
  test("生命周期动作经 api 根键路由到 workspaces/:slug/employees/:key/:action", async () => {
    const seen: Seg[] = [];
    const inputs: unknown[] = [];
    const root = {
      api: recordingRoute(seen, async (input) => {
        inputs.push(input);
        return { ok: true, status: 200, json: async () => ({ employee: { status: "paused" } }) };
      }),
    };
    const client = createOfficeLifecycleClient(root as never);
    const outcome = await client({ slug: "sck-x", employeeKey: "ve_1", action: "pause" });
    expect(seen).toEqual(["workspaces", ":slug", "employees", ":employeeKey", "pause", "$post"]);
    expect(inputs).toEqual([{ param: { slug: "sck-x", employeeKey: "ve_1" } }]);
    expect(outcome).toMatchObject({ ok: true, status: "paused" });
  });

  test("默认工厂从 hc client 的 .api 根键进入（缺一层即生产 405 的回归面）", async () => {
    const seen: Seg[] = [];
    const proxyRoot = recordingRoute(seen, async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    const client = createOfficeLifecycleClient(proxyRoot as never);
    await client({ slug: "sck-x", employeeKey: "ve_1", action: "retire" });
    expect(seen[0]).toBe("api");
    expect(seen.slice(1)).toEqual(["workspaces", ":slug", "employees", ":employeeKey", "retire", "$post"]);
  });

  test("非 2xx 把状态码译成可读错误，抛错也归一为 ok:false", async () => {
    const client405 = createOfficeLifecycleClient({
      api: recordingRoute([], async () => ({
        ok: false,
        status: 405,
        json: async () => ({}),
      })),
    } as never);
    expect(await client405({ slug: "s", employeeKey: "e", action: "pause" })).toMatchObject({
      ok: false,
      message: "请求失败 (405)",
    });

    const clientThrow = createOfficeLifecycleClient({
      api: recordingRoute([], async () => {
        throw new Error("network down");
      }),
    } as never);
    expect(await clientThrow({ slug: "s", employeeKey: "e", action: "pause" })).toMatchObject({
      ok: false,
      message: "network down",
    });
  });
});
