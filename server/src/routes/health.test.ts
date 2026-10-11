import { describe, expect, test } from "bun:test";
import { createHealthRoutes } from "./health";

function request(routes: ReturnType<typeof createHealthRoutes>) {
  return routes.request("/health");
}

const up = async () => true;
const down = async () => false;

describe("health route", () => {
  test("探测连接与业务 root 连接均为真时报告 status=ok / surrealdb=up", async () => {
    const calls: Array<number | undefined> = [];
    const routes = createHealthRoutes({
      checkHealthProbe: async (timeoutMs) => {
        calls.push(timeoutMs);
        return true;
      },
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
    // 两条连接各沿用 5s 预算。
    expect(calls.sort()).toEqual([5000, 5000]);
  });

  test("探测连接失败 → 如实 down（演练断连对象的失败即 /health down）", async () => {
    const routes = createHealthRoutes({
      checkHealthProbe: down,
      checkRootConnection: up,
    });

    const body = (await (await request(routes)).json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.surrealdb).toBe("down");
  });

  test("业务 root 连接失败 → 如实 down（业务信号不丢，不常 ok）", async () => {
    const routes = createHealthRoutes({
      checkHealthProbe: up,
      checkRootConnection: down,
    });

    const body = (await (await request(routes)).json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.surrealdb).toBe("down");
  });

  test("两条连接都失败 → degraded / down", async () => {
    const routes = createHealthRoutes({
      checkHealthProbe: down,
      checkRootConnection: down,
    });

    const body = (await (await request(routes)).json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.surrealdb).toBe("down");
  });
});
