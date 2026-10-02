import { describe, expect, test } from "bun:test";
import { DateTime } from "surrealdb";
import {
  normalizeEmployee,
  normalizeMessage,
  normalizeNotification,
  normalizeOfficeMeta,
  normalizeReport,
  normalizeTask,
} from "./office-data";

/**
 * b09c87b1 QA 退回回归：surrealdb@2.0.8 把 datetime 解码为 `DateTime` 实例
 *（连接未开 useNativeDates），normalize* 曾只认 Date/字符串，所有时间字段
 * 归一成 null（活动时间「—」、resolved_at 恒 null 致已解决通知被计为待处理）。
 */

const ISO = "2026-09-30T01:00:00.000Z";

describe("normalize* — SDK DateTime 解码形状（b09c87b1 回归）", () => {
  test("DateTime 实例归一化为 ISO 字符串", () => {
    const employee = normalizeEmployee({
      id: "user:ve_1",
      kind: "virtual",
      virtual_profile: { status: "active", last_active_at: new DateTime(ISO) },
      created_at: new DateTime(ISO),
    });
    expect(employee.lastActiveAt).toBe(ISO);
    expect(employee.createdAt).toBe(ISO);

    const task = normalizeTask({
      id: "office_task:t1",
      due_at: new DateTime(ISO),
      created_at: new DateTime(ISO),
      updated_at: new DateTime(ISO),
    });
    expect(task.dueAt).toBe(ISO);
    expect(task.updatedAt).toBe(ISO);

    const message = normalizeMessage({ id: "office_message:m1", created_at: new DateTime(ISO) });
    expect(message.createdAt).toBe(ISO);

    const report = normalizeReport({ id: "office_report:r1", created_at: new DateTime(ISO) });
    expect(report.createdAt).toBe(ISO);

    const meta = normalizeOfficeMeta({ id: "office_meta:current", updated_at: new DateTime(ISO) });
    expect(meta.updatedAt).toBe(ISO);
  });

  test("已解决通知的 resolved_at 归一化后仍为真值，pending 判定不再失真", () => {
    const notification = normalizeNotification({
      id: "user_notification:n1",
      resolved_at: new DateTime(ISO),
      created_at: new DateTime(ISO),
    });
    expect(notification.resolvedAt).toBe(ISO);
    expect(notification.createdAt).toBe(ISO);
  });

  test("Date 实例与 ISO 字符串路径不变；缺失/非时间值仍为 null", () => {
    const employee = normalizeEmployee({
      id: "user:ve_1",
      kind: "virtual",
      virtual_profile: { status: "active", last_active_at: new Date(ISO) },
      created_at: ISO,
    });
    expect(employee.lastActiveAt).toBe(ISO);
    expect(employee.createdAt).toBe(ISO);

    const bare = normalizeEmployee({ id: "user:ve_1", kind: "virtual", virtual_profile: { status: "active" } });
    expect(bare.lastActiveAt).toBeNull();
    expect(bare.createdAt).toBe("");

    const weird = normalizeNotification({ id: "user_notification:n1", resolved_at: { nested: true } });
    expect(weird.resolvedAt).toBeNull();
  });
});
