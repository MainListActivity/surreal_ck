import { describe, expect, test } from "bun:test";
import {
  aggregateActivity,
  describeActivity,
  loadActivityRows,
  normalizeRow,
  type ActivityEventRow,
} from "./activity-feed";
import type { SurrealConn } from "./surreal";
import { RecordId } from "surrealdb";

describe("loadActivityRows — 读最近动态", () => {
  test("发出按 created_at DESC 排序的查询，带 limit 绑定", async () => {
    let sql = "";
    let bindings: Record<string, unknown> | undefined;
    const conn = {
      query: async (q: string, b?: Record<string, unknown>) => {
        sql = q;
        bindings = b;
        return [];
      },
    } as unknown as Pick<SurrealConn, "query">;

    await loadActivityRows(conn, 30);

    expect(sql).toContain("FROM activity_event");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT $limit");
    // PERMISSIONS 兜底，查询不带鉴权过滤
    expect(sql).not.toMatch(/WHERE .*\$auth/);
    expect(bindings).toEqual({ limit: 30 });
  });

  test("规整 SDK 读回的行：RecordId → string", async () => {
    const conn = {
      query: async () => [
        {
          id: new RecordId("activity_event", "e1"),
          actor: new RecordId("user", "u1"),
          verb: "workbook.create",
          target_kind: "workbook",
          target_name: "台账",
          target: new RecordId("workbook", "wb1"),
          created_at: "2026-06-26T10:00:00Z",
        },
      ],
    } as unknown as Pick<SurrealConn, "query">;

    const rows = await loadActivityRows(conn);
    expect(rows[0]).toEqual({
      id: "activity_event:e1",
      actor: "user:u1",
      verb: "workbook.create",
      target_kind: "workbook",
      target_name: "台账",
      target: "workbook:wb1",
      created_at: "2026-06-26T10:00:00Z",
    });
  });

  test("缺省 actor / target 不报错", () => {
    const row = normalizeRow({ id: "activity_event:e2", verb: "ai.write", created_at: "2026-06-26T10:00:00Z" });
    expect(row.actor).toBeUndefined();
    expect(row.target).toBeUndefined();
    expect(row.verb).toBe("ai.write");
  });
});

describe("describeActivity — verb → 中文文案", () => {
  test("有 target_name 时填入名字", () => {
    expect(describeActivity("workbook.create", "债权台账", 1)).toBe("新建了工作簿「债权台账」");
    expect(describeActivity("field.remove", "状态", 1)).toBe("删除了字段「状态」");
  });

  test("无 target_name 时退化成 bare 文案", () => {
    expect(describeActivity("workbook.create", undefined, 1)).toBe("新建了一个工作簿");
  });

  test("record.* 文案带数量", () => {
    expect(describeActivity("record.write", undefined, 12)).toBe("添加了 12 条记录");
    expect(describeActivity("record.delete", undefined, 3)).toBe("删除了 3 条记录");
  });

  test("未知 verb 有兜底文案", () => {
    expect(describeActivity("nope", undefined, 1)).toBe("进行了一次操作");
  });
});

describe("aggregateActivity — 窗口聚合", () => {
  const base = "2026-06-26T10:00:00.000Z";
  const at = (offsetSec: number) => new Date(Date.parse(base) + offsetSec * 1000).toISOString();

  function row(over: Partial<ActivityEventRow>): ActivityEventRow {
    return {
      id: `activity_event:${Math.random()}`,
      verb: "record.write",
      created_at: base,
      ...over,
    };
  }

  test("同人同表短时窗口内的 record.write 合并成一条，count 累加", () => {
    const rows = [
      row({ actor: "user:u1", target: "ent_abc_main:r3", created_at: at(0) }),
      row({ actor: "user:u1", target: "ent_abc_main:r2", created_at: at(-10) }),
      row({ actor: "user:u1", target: "ent_abc_main:r1", created_at: at(-20) }),
    ];
    const items = aggregateActivity(rows);
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(3);
    expect(items[0].action).toBe("添加了 3 条记录");
    expect(items[0].actorId).toBe("user:u1");
  });

  test("不同 actor 不合并", () => {
    const rows = [
      row({ actor: "user:u1", target: "ent_abc_main:r1", created_at: at(0) }),
      row({ actor: "user:u2", target: "ent_abc_main:r2", created_at: at(-5) }),
    ];
    expect(aggregateActivity(rows)).toHaveLength(2);
  });

  test("不同表不合并", () => {
    const rows = [
      row({ actor: "user:u1", target: "ent_abc_main:r1", created_at: at(0) }),
      row({ actor: "user:u1", target: "ent_xyz_main:r1", created_at: at(-5) }),
    ];
    expect(aggregateActivity(rows)).toHaveLength(2);
  });

  test("超出时间窗口不合并", () => {
    const rows = [
      row({ actor: "user:u1", target: "ent_abc_main:r1", created_at: at(0) }),
      row({ actor: "user:u1", target: "ent_abc_main:r2", created_at: at(-600) }), // 10 分钟前 > 5 分钟窗口
    ];
    expect(aggregateActivity(rows)).toHaveLength(2);
  });

  test("非 record verb 一行一条，不聚合", () => {
    const rows = [
      row({ verb: "workbook.create", actor: "user:u1", target_name: "A", target: "workbook:a", created_at: at(0) }),
      row({ verb: "workbook.create", actor: "user:u1", target_name: "B", target: "workbook:b", created_at: at(-1) }),
    ];
    const items = aggregateActivity(rows);
    expect(items).toHaveLength(2);
    expect(items[0].action).toBe("新建了工作簿「A」");
    expect(items[1].action).toBe("新建了工作簿「B」");
  });

  test("record.delete 与 record.write 不互相合并", () => {
    const rows = [
      row({ verb: "record.write", actor: "user:u1", target: "ent_abc_main:r1", created_at: at(0) }),
      row({ verb: "record.delete", actor: "user:u1", target: "ent_abc_main:r2", created_at: at(-5) }),
    ];
    expect(aggregateActivity(rows)).toHaveLength(2);
  });

  test("输出不带聚合中间字段（targetName/targetTable）", () => {
    const items = aggregateActivity([row({ actor: "user:u1", target: "ent_abc_main:r1" })]);
    expect(Object.keys(items[0]).sort()).toEqual(["action", "actorId", "count", "id", "timestamp", "verb"]);
  });
});
