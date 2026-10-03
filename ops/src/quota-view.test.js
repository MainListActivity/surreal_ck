import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  capacityLabel,
  planLabel,
  timelineDetail,
  timelineTime,
  usageNumbers,
  workspaceRecordId,
} from "./quota-view.js";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");

// 生产 69d91ab 实测：详情页 106 个资源行全显「— / —」、当前计划「—」、配额状态恒 normal，
// 而 API 实际返回 applied=Max v2、capacity=at_limit、实体表字段 11/11。下面是按
// shared/src/native-quota/api.ts 真实形状的字段路径回归。
describe("ops 配额工作区详情面板字段路径", () => {
  test("资源行读 usage.used / usage.limit，不再读不存在的 resource.used/limit", () => {
    expect(usageNumbers({ kind: "finite", limit: 11, used: 4 })).toEqual({ used: 4, limit: 11, unlimited: false });
    expect(usageNumbers({ kind: "finite", limit: "11", used: "4" })).toEqual({ used: "4", limit: "11", unlimited: false });
    // 账本不可信：used 为 null 必须如实透出，不能默认 0。
    expect(usageNumbers({ kind: "finite", limit: 11, used: null })).toEqual({ used: null, limit: 11, unlimited: false });
    expect(usageNumbers({ kind: "unlimited", used: 7 })).toEqual({ used: 7, limit: null, unlimited: true });
    expect(usageNumbers(undefined)).toEqual({ used: null, limit: null, unlimited: false });
    expect(usageNumbers("nonsense")).toEqual({ used: null, limit: null, unlimited: false });
    expect(source).not.toContain("resource.used");
    expect(source).not.toContain("resource.limit");
    expect(source).toContain("usageNumbers(resource.usage)");
  });

  test("当前计划读 applied.plan_name，不再读 operator.applied_plan_name", () => {
    expect(planLabel({ plan_name: "Max v2", plan_revision: 3 })).toBe("Max v2 · r3");
    expect(planLabel({ plan_name: "Plus", plan_revision: null })).toBe("Plus");
    // 未绑定期如实显示缺失，不猜套餐名。
    expect(planLabel(null)).toBeNull();
    expect(planLabel({})).toBeNull();
    expect(source).not.toContain("operator?.applied_plan_name");
    expect(source).toContain("planLabel(view.applied)");
  });

  test("配额状态读 statuses.capacity，覆盖全部六态，缺失显示未知而不再默认 normal", () => {
    expect(capacityLabel("normal")).toBe("正常");
    expect(capacityLabel("warning")).toBe("预警");
    expect(capacityLabel("critical")).toBe("危急");
    expect(capacityLabel("at_limit")).toBe("已达上限");
    expect(capacityLabel("over_limit")).toBe("已超上限");
    expect(capacityLabel("unknown")).toBe("未知");
    expect(capacityLabel(undefined)).toBe("未知");
    expect(capacityLabel("mystery-state")).toBe("未知");
    expect(source).not.toContain("capacity_state");
    expect(source).not.toContain('|| "normal"');
    expect(source).toContain("capacityLabel(view.statuses?.capacity)");
  });

  test("工作区 ID 读 operator.workspace_record，缺失才回落 workspace.id", () => {
    expect(workspaceRecordId({ operator: { workspace_record: "workspace:abc" }, workspace: { id: "workspace:xyz" } })).toBe("workspace:abc");
    expect(workspaceRecordId({ operator: null, workspace: { id: "workspace:xyz" } })).toBe("workspace:xyz");
    expect(workspaceRecordId({})).toBeNull();
    expect(source).toContain("workspaceRecordId(view)");
  });

  test("时间线行按 occurred_at / label / state / error_code 展示，不再读不存在的字段", () => {
    expect(timelineTime("2026-10-03T09:12:02.056983941Z")).toBe("2026-10-03 09:12:02");
    expect(timelineTime(null)).toBeNull();
    expect(timelineTime("")).toBeNull();
    expect(timelineDetail({ kind: "operator_intent", label: "quota_change", state: "processed" })).toBe("quota_change · processed");
    expect(timelineDetail({ kind: "audit", label: "audit", state: "failed", error_code: "drift" })).toBe("audit · failed · 错误 drift");
    // label 缺失时退回 kind，仍不显示空行。
    expect(timelineDetail({ kind: "operator_intent", state: "pending" })).toBe("operator_intent · pending");
    expect(timelineDetail({ kind: "audit" })).toBe("audit");
    expect(timelineDetail({})).toBeNull();
    expect(source).not.toContain("event_kind");
    expect(source).not.toContain("created_at");
    expect(source).toContain("timelineDetail(item)");
  });

  test("详情面板仍然渲染内容权益与操作表单（无回归）", () => {
    expect(source).toContain("renderProductEntitlement(product)");
    expect(source).toContain('id="product-assign"');
    expect(source).toContain("/ops/product-entitlements/grants");
    expect(source).toContain("/delivery-preview");
  });
});
