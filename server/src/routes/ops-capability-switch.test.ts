import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createOpsCapabilitySwitchRoutes } from "./ops-capability-switch";

type Row = Record<string, unknown>;

/** 极简 _system 假件：两张表 + UPSERT/INSERT 语义，够路由测试用。 */
function fakeSystemDb() {
  const switches = new Map<string, Row>();
  const batches = new Map<string, Row>();
  const calls: string[] = [];
  return {
    switches,
    batches,
    calls,
    async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
      calls.push(sql);
      if (sql.includes("FROM platform_capability_switch")) {
        return [[...switches.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))];
      }
      if (sql.includes("FROM platform_rollout_batch")) {
        return [[...batches.values()].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))];
      }
      if (sql.includes("UPSERT $id CONTENT")) {
        const id = String((params.id as { toString(): string }).toString());
        switches.set(id, {
          id,
          mode: params.mode,
          workspaces: params.workspaces,
          note: params.note,
          updated_by: params.by,
          updated_at: "now",
        });
        return [[]];
      }
      if (sql.includes("INSERT INTO platform_rollout_batch")) {
        const id = String((params.id as { toString(): string }).toString());
        if (!batches.has(id)) {
          batches.set(id, {
            id,
            capability: params.capability,
            workspaces: params.workspaces,
            note: params.note,
            created_by: params.by,
            created_at: `2026-09-24T00:00:0${batches.size}Z`,
          });
        }
        return [[]];
      }
      return [[]];
    },
  };
}

function makeApp(opts: {
  db: ReturnType<typeof fakeSystemDb>;
  /** 每个能力位被要求时记录的调用；默认一律放行并注入 operator。 */
  deny?: (capability: string) => boolean;
}) {
  const requiredCaps: string[] = [];
  const requireOperator = (capability: string): MiddlewareHandler<AppBindings> =>
    async (c, next) => {
      requiredCaps.push(capability);
      if (opts.deny?.(capability)) {
        return c.json({ error: { code: "capability-denied" } }, 403);
      }
      c.set("platformOperator", { subject: "ops-human", kind: "human", capabilities: [] });
      await next();
    };
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route("/", createOpsCapabilitySwitchRoutes({
    getSystemDb: async () => opts.db,
    requireOperator: requireOperator as never,
  }));
  return { app, requiredCaps };
}

describe("ops capability switch routes（LCA-14 灰度开关）", () => {
  test("PUT 置开关 + GET 回读：mode/cohort/操作者/时间全部落库", async () => {
    const db = fakeSystemDb();
    const { app } = makeApp({ db });

    const res = await app.request("/api/ops/capability-switches/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "cohort", workspaces: ["ws-a", "ws-b"], note: "第一波灰度" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "cohort", workspaces: ["ws-a", "ws-b"], updatedBy: "ops-human" });

    const row = db.switches.get("platform_capability_switch:content");
    expect(row).toMatchObject({ mode: "cohort", workspaces: ["ws-a", "ws-b"], updated_by: "ops-human" });

    const list = await app.request("/api/ops/capability-switches");
    const body = (await list.json()) as { switches: { key: string; mode: string }[] };
    expect(body.switches).toEqual([
      expect.objectContaining({ key: "content", mode: "cohort", workspaces: ["ws-a", "ws-b"] }),
    ]);
  });

  test("未知能力键 404；非法请求体 400", async () => {
    const { app } = makeApp({ db: fakeSystemDb() });
    const bad = await app.request("/api/ops/capability-switches/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "off" }),
    });
    expect(bad.status).toBe(404);
    const invalid = await app.request("/api/ops/capability-switches/ai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "sometimes" }),
    });
    expect(invalid.status).toBe(400);
  });

  test("批次记录幂等：同一 idempotencyKey 重复提交只建一行", async () => {
    const db = fakeSystemDb();
    const { app } = makeApp({ db });
    const body = {
      capability: "ai",
      workspaces: ["ws-a"],
      note: "批次一",
      idempotencyKey: "rollout-2026-09-24-wave1",
    };
    const first = await app.request("/api/ops/capability-switches/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const again = await app.request("/api/ops/capability-switches/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(again.status).toBe(201);
    expect(db.batches.size).toBe(1);

    const list = await app.request("/api/ops/capability-switches/batches");
    const listed = (await list.json()) as { batches: { capability: string; workspaces: string[] }[] };
    expect(listed.batches).toEqual([
      expect.objectContaining({ capability: "ai", workspaces: ["ws-a"], note: "批次一", created_by: "ops-human" }),
    ]);
  });

  test("读路径要 quota.read、写路径要 capability.switch——能力位分离", async () => {
    const { app, requiredCaps } = makeApp({ db: fakeSystemDb() });
    await app.request("/api/ops/capability-switches");
    await app.request("/api/ops/capability-switches/ai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "off", note: "演练" }),
    });
    expect(requiredCaps).toEqual(["quota.read", "capability.switch"]);

    const denied = makeApp({ db: fakeSystemDb(), deny: (cap) => cap === "capability.switch" });
    const res = await denied.app.request("/api/ops/capability-switches/ai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "off" }),
    });
    expect(res.status).toBe(403);
  });
});
