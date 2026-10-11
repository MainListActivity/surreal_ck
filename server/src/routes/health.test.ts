import { describe, expect, test } from "bun:test";
import { createHealthRoutes } from "./health";

function request(routes: ReturnType<typeof createHealthRoutes>) {
  return routes.request("/health");
}

describe("health route", () => {
  test("root 连接探测为真时报告 status=ok / surrealdb=up", async () => {
    const calls: Array<number | undefined> = [];
    const routes = createHealthRoutes({
      checkRootConnection: async (timeoutMs) => {
        calls.push(timeoutMs);
        return true;
      },
    });

    const response = await request(routes);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.surrealdb).toBe("up");
    expect(body).toHaveProperty("quotaWorker");
    expect(body).toHaveProperty("uptimeSec");
    // 探测沿用 5s 预算。
    expect(calls).toEqual([5000]);
  });

  test("root 连接探测为假时如实报告 degraded / surrealdb=down（不常 ok）", async () => {
    const routes = createHealthRoutes({
      checkRootConnection: async () => false,
    });

    const response = await request(routes);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.surrealdb).toBe("down");
  });
});
