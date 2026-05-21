import { describe, expect, test } from "bun:test";
import {
  ResolvedRecordSchema,
  ResumeAiWorkflowRequestSchema,
  WorkflowSuspendedEventSchema,
} from "./rpc.types";

describe("ResolvedRecordSchema", () => {
  test("接受合法的 id+label", () => {
    expect(ResolvedRecordSchema.safeParse({ id: "claim:abc123", label: "张三 / ZQ-2026-001" }).success).toBe(true);
  });

  test("拒绝缺 id 或 label", () => {
    expect(ResolvedRecordSchema.safeParse({ id: "", label: "x" }).success).toBe(false);
    expect(ResolvedRecordSchema.safeParse({ id: "x", label: "" }).success).toBe(false);
    expect(ResolvedRecordSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("ResumeAiWorkflowRequestSchema", () => {
  test("candidate-chosen 必须带 candidateId", () => {
    const ok = ResumeAiWorkflowRequestSchema.safeParse({
      runId: "r1",
      decision: { kind: "candidate-chosen", candidateId: "claim:abc" },
    });
    expect(ok.success).toBe(true);
    const bad = ResumeAiWorkflowRequestSchema.safeParse({
      runId: "r1",
      decision: { kind: "candidate-chosen" },
    });
    expect(bad.success).toBe(false);
  });

  test("资源候选 resume 只接受 resourceIds 数组", () => {
    const ok = ResumeAiWorkflowRequestSchema.safeParse({
      runId: "r1",
      decision: { kind: "resource-candidates-chosen", resourceIds: ["resource_item:r1", "resource_item:r2"] },
    });
    expect(ok.success).toBe(true);
    const bad = ResumeAiWorkflowRequestSchema.safeParse({
      runId: "r1",
      decision: { kind: "resource-candidates-chosen", resources: [{ id: "resource_item:r1" }] },
    });
    expect(bad.success).toBe(false);
  });

  test("7 种 decision kind 全部接受", () => {
    for (const decision of [
      { kind: "candidate-chosen", candidateId: "c" },
      { kind: "candidate-cancelled" },
      { kind: "write-confirmed" },
      { kind: "write-rejected" },
      { kind: "resource-candidates-chosen", resourceIds: ["resource_item:r1"] },
      { kind: "resource-candidates-manual-research" },
      { kind: "manual-research-completed", resourceIds: ["resource_item:r1"] },
    ] as const) {
      expect(
        ResumeAiWorkflowRequestSchema.safeParse({ runId: "r1", decision }).success,
      ).toBe(true);
    }
  });
});

describe("WorkflowSuspendedEventSchema", () => {
  test("ambiguous-candidates 包含候选数组与 truncated", () => {
    const e = WorkflowSuspendedEventSchema.safeParse({
      kind: "ambiguous-candidates",
      runId: "r1",
      candidates: [{ id: "x", label: "X" }],
      truncated: false,
    });
    expect(e.success).toBe(true);
  });

  test("resource-candidates 包含可多选资源候选", () => {
    const e = WorkflowSuspendedEventSchema.safeParse({
      kind: "resource-candidates",
      runId: "r1",
      candidates: [{
        id: "resource_item:r1",
        label: "资料 A",
        summary: "摘要",
        score: 0.42,
        resourceType: "generic_note",
        sourceUrl: "https://example.com/a",
      }],
    });
    expect(e.success).toBe(true);
  });

  test("manual-research 暂停事件携带持久 session 信息", () => {
    const e = WorkflowSuspendedEventSchema.safeParse({
      kind: "manual-research",
      runId: "r1",
      sessionId: "research_session:s1",
      workspaceId: "workspace:demo",
      query: "查找合同解除案例",
      resourceType: "generic_note",
    });
    expect(e.success).toBe(true);
  });

  test("await-write-confirm 携带 navigation/dashboard/rowPatch 之一", () => {
    const e = WorkflowSuspendedEventSchema.safeParse({
      kind: "await-write-confirm",
      runId: "r1",
      intent: { type: "open-workbook", workbookId: "w:1" },
    });
    expect(e.success).toBe(true);
  });
});
