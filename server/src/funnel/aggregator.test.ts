import { describe, expect, test } from "bun:test";
import {
  aggregateFunnelCounts,
  countFunnelRows,
  dayDiff,
  firstSuccessDay,
  readWorkspaces,
  returnWeek2Day,
  type FunnelAggregationClient,
} from "./aggregator";

/** 按语句前缀匹配返回 canned 结果的假客户端；记录全部 use 切换与写入语句。 */
function fakeClient(routes: { match: RegExp; result: unknown }[]) {
  const calls: { sql: string }[] = [];
  const uses: string[] = [];
  return {
    client: {
      async use(scope: { namespace: string; database: string }) {
        uses.push(scope.database);
      },
      async query(sql: string, _params?: Record<string, unknown>) {
        calls.push({ sql });
        const route = routes.find((candidate) => candidate.match.test(sql));
        if (!route) throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
        return route.result;
      },
    } satisfies FunnelAggregationClient,
    calls,
    uses,
  };
}

const HASH_KEY = "test-hash-key-0123456789";

function stubRows(result: unknown) {
  return result;
}

describe("dayDiff", () => {
  test("UTC 日期差", () => {
    expect(dayDiff("2026-10-20", "2026-10-27")).toBe(7);
    expect(dayDiff("2026-10-20", "2026-10-20")).toBe(0);
    expect(dayDiff("2026-10-20", "2026-10-19")).toBe(-1);
  });
});

describe("countFunnelRows / firstSuccessDay", () => {
  test("按 (event, day) 精确计数", () => {
    const counts = countFunnelRows([
      { event: "first_login", day: "2026-10-28" },
      { event: "first_login", day: "2026-10-28" },
      { event: "first_login", day: "2026-10-29" },
      { event: "template_created", day: "2026-10-29" },
      { event: "import_succeeded", day: "2026-10-29" },
    ]);
    expect(counts.get("first_login|2026-10-28")).toBe(2);
    expect(counts.get("first_login|2026-10-29")).toBe(1);
    expect(counts.get("template_created|2026-10-29")).toBe(1);
    expect(counts.size).toBe(4);
  });

  test("firstSuccessDay 取最早日", () => {
    expect(firstSuccessDay([
      { event: "first_success", day: "2026-10-24" },
      { event: "first_success", day: "2026-10-20" },
    ])).toBe("2026-10-20");
    expect(firstSuccessDay([{ event: "first_login", day: "2026-10-20" }])).toBeNull();
  });
});

describe("returnWeek2Day", () => {
  const successDay = "2026-10-20";

  test("窗口内（日差 7–13）命中取最早", () => {
    expect(returnWeek2Day(successDay, ["2026-10-28", "2026-10-27"])).toBe("2026-10-27");
    expect(returnWeek2Day(successDay, ["2026-10-27"])).toBe("2026-10-27");
    expect(returnWeek2Day(successDay, ["2026-11-02"])).toBe("2026-11-02");
  });

  test("日差 14 与 6 都不算（day >= 7 && day <= 13，activation-outcomes.ts:194）", () => {
    expect(returnWeek2Day(successDay, ["2026-11-03"])).toBeNull();
    expect(returnWeek2Day(successDay, ["2026-10-26"])).toBeNull();
  });

  test("窗口为空返回 null", () => {
    expect(returnWeek2Day(successDay, [])).toBeNull();
  });
});

describe("readWorkspaces", () => {
  test("过滤缺 db_name 或 slug 的行", () => {
    expect(readWorkspaces([[
      { id: "workspace:1", db_name: "sck_a", slug: "sck-a" },
      { id: "workspace:2", db_name: "sck_b" },
      { id: "workspace:3", slug: "sck-c" },
    ]])).toEqual([{ dbName: "sck_a", slug: "sck-a" }]);
  });
});

describe("aggregateFunnelCounts", () => {
  function baseRoutes(overrides: { funnelRows?: unknown; writeDays?: unknown } = {}) {
    return [
      { match: /FROM workspace WHERE status = 'active'/, result: [[
        { id: "workspace:1", db_name: "sck_demo", slug: "sck-demo" },
      ]] },
      { match: /FROM ops_invitation WHERE status = 'completed'/, result: [[
        { created_at: "2026-10-28T10:00:00Z", workspace_slug: "sck-demo" },
        { created_at: "2026-10-28T11:00:00Z", workspace_slug: "sck-demo" },
        { created_at: "2026-10-29T09:00:00Z", workspace_slug: "sck-demo" },
      ]] },
      { match: /FROM funnel_event/, result: overrides.funnelRows ?? [[]] },
      { match: /FROM activity_event/, result: overrides.writeDays ?? [[]] },
      { match: /INSERT INTO funnel_event_count/, result: [] },
    ];
  }

  test("重算 (event, day) 计数并 UPSERT，count 为精确值", async () => {
    const { client, calls } = fakeClient(baseRoutes({
      funnelRows: [[
        { event: "first_login", day: "2026-10-28", subject: "user:1" },
        { event: "first_login", day: "2026-10-28", subject: "user:2" },
        { event: "import_succeeded", day: "2026-10-29", subject: "import_batch:1" },
        { event: "first_success", day: "2026-10-29", subject: "import_batch:1" },
        { event: "ai_proposal_adopted", day: "2026-10-29", subject: "chat_write_fence:1" },
      ]],
    }));
    const result = await aggregateFunnelCounts(client, { hashKey: HASH_KEY });
    expect(result.workspaces).toBe(1);
    expect(result.skippedNoHashKey).toBe(false);
    expect(result.failedWorkspaces).toEqual([]);
    // 邀请按（日, 工作区）分组 2 条 + 漏斗事件按（event, day）分组 4 条 = 6；
    // first_success 存在但窗口无 record.write，不产生 return_week2。
    expect(result.computed).toBe(6);
    expect(result.written).toBe(6);
    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO funnel_event_count"));
    expect(inserts.length).toBe(6);
  });

  test("return_week2 只在日差 7–13 命中；day+14 不产生计数", async () => {
    const funnelRows = [[{ event: "first_success", day: "2026-10-20", subject: "import_batch:1" }]];
    const inside = fakeClient(baseRoutes({ funnelRows, writeDays: [["2026-10-27"]] }));
    const insideResult = await aggregateFunnelCounts(inside.client, { hashKey: HASH_KEY });
    expect(insideResult.computed).toBe(4); // 3 邀请 + 1 first_success + 1 return_week2
    expect(insideResult.written).toBe(4);

    const outside = fakeClient(baseRoutes({ funnelRows, writeDays: [["2026-11-03"]] }));
    const outsideResult = await aggregateFunnelCounts(outside.client, { hashKey: HASH_KEY });
    expect(outsideResult.computed).toBe(3);
    expect(outsideResult.written).toBe(3);
  });

  test("重复执行幂等：INSERT 带 ON DUPLICATE KEY UPDATE 且 count 恒为重算值", async () => {
    const routes = baseRoutes({
      funnelRows: [[{ event: "first_login", day: "2026-10-28", subject: "user:1" }]],
    });
    const first = fakeClient(routes);
    const second = fakeClient(routes);
    await aggregateFunnelCounts(first.client, { hashKey: HASH_KEY });
    await aggregateFunnelCounts(second.client, { hashKey: HASH_KEY });
    expect(first.calls.filter((c) => c.sql.includes("INSERT INTO funnel_event_count")).length)
      .toBe(second.calls.filter((c) => c.sql.includes("INSERT INTO funnel_event_count")).length);
    for (const run of [first, second]) {
      const insert = run.calls.find((c) => c.sql.includes("INSERT INTO funnel_event_count"));
      expect(insert?.sql).toContain("ON DUPLICATE KEY UPDATE count = $count");
    }
  });

  test("无哈希密钥：只重算不写入", async () => {
    const { client, calls } = fakeClient(baseRoutes({
      funnelRows: [[{ event: "first_login", day: "2026-10-28", subject: "user:1" }]],
    }));
    const result = await aggregateFunnelCounts(client, { hashKey: "" });
    expect(result.skippedNoHashKey).toBe(true);
    expect(result.computed).toBe(3);
    expect(result.written).toBe(0);
    expect(calls.filter((c) => c.sql.includes("INSERT INTO funnel_event_count")).length).toBe(0);
  });

  test("单个工作区失败不阻塞其余工作区", async () => {
    const failing = {
      async use(scope: { namespace: string; database: string }) {
        if (scope.database === "sck_bad") throw new Error("db unavailable");
      },
      async query(sql: string) {
        if (/FROM workspace WHERE status = 'active'/.test(sql)) {
          return [[
            { id: "workspace:1", db_name: "sck_bad", slug: "sck-bad" },
            { id: "workspace:2", db_name: "sck_good", slug: "sck-good" },
          ]];
        }
        if (/FROM ops_invitation/.test(sql)) return [[
          { created_at: "2026-10-28T10:00:00Z", workspace_slug: "sck-good" },
        ]];
        if (/FROM funnel_event/.test(sql)) return [[]];
        if (/INSERT INTO funnel_event_count/.test(sql)) return [];
        throw new Error(`unexpected query: ${sql.slice(0, 50)}`);
      },
    } satisfies FunnelAggregationClient;
    const result = await aggregateFunnelCounts(failing, { hashKey: HASH_KEY });
    expect(result.workspaces).toBe(2);
    expect(result.failedWorkspaces).toEqual(["sck_bad"]);
    expect(result.written).toBe(1);
  });
});

describe("canned result shape guard", () => {
  test("stubRows 保持数组形状（防误改为裸对象）", () => {
    expect(stubRows([[]])).toEqual([[]]);
  });
});
