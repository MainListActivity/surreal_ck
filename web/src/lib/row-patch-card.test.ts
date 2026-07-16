import { describe, expect, test } from "bun:test";
import type { RecordWriteProposal, RowPatchProposal } from "@surreal-ck/shared";
import {
  createRowPatchCard,
  formatRowPatchValue,
  type ConfirmableRecordProposal,
  type RowPatchCardState,
} from "./row-patch-card";

function proposal(over: Partial<RowPatchProposal> = {}): RowPatchProposal {
  return {
    type: "row-patch-proposal",
    sheetId: "sheet:claims",
    recordId: "ent_claim:one",
    proposals: [
      { field: "amount", currentValue: 100, suggestedValue: 250, basis: "依据合同附件二", confidence: "high" },
      { field: "status", currentValue: "新", suggestedValue: "已确认", basis: "对账单已盖章", confidence: "low" },
    ],
    ...over,
  };
}

function cardHarness(input: {
  proposal?: ConfirmableRecordProposal;
  write?: (values: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; message: string }>;
  resume?: (decision: { kind: "write-confirmed" | "write-rejected" }) => Promise<void>;
} = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const resumes: Array<{ kind: "write-confirmed" | "write-rejected" }> = [];
  const states: RowPatchCardState[] = [];
  const card = createRowPatchCard({
    proposal: input.proposal ?? proposal(),
    write: input.write ?? (async (values) => {
      writes.push(values);
      return { ok: true };
    }),
    resume: input.resume ?? (async (decision) => {
      resumes.push(decision);
    }),
    onChange: (state) => states.push(state),
  });
  return { card, writes, resumes, states };
}

describe("行分析提案卡状态机", () => {
  test("新建记录提案在确认前零写入，确认后只提交接受的字段", async () => {
    const createProposal: RecordWriteProposal = {
      type: "record-write-proposal",
      operation: "create",
      sheetId: "sheet:tasks",
      proposals: [
        { field: "task_name", currentValue: null, suggestedValue: "补充材料", basis: "材料缺失", confidence: "high" },
        { field: "due_date", currentValue: null, suggestedValue: "2026-07-20", basis: "建议期限", confidence: "medium" },
      ],
    };
    const { card, writes, resumes } = cardHarness({ proposal: createProposal });

    expect(writes).toEqual([]);
    card.setAccepted("due_date", false);
    await card.confirm();

    expect(writes).toEqual([{ task_name: "补充材料" }]);
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
  });

  test("从 RowPatchProposal 初始化：逐字段展示当前值/建议值/依据/置信度，默认全部接受", () => {
    const { card } = cardHarness();

    const state = card.snapshot();
    expect(state.status).toBe("pending");
    expect(state.error).toBeNull();
    expect(state.fields).toEqual([
      { field: "amount", currentValue: 100, suggestedValue: 250, basis: "依据合同附件二", confidence: "high", accepted: true },
      { field: "status", currentValue: "新", suggestedValue: "已确认", basis: "对账单已盖章", confidence: "low", accepted: true },
    ]);
  });

  test("忽略部分字段后确认：只写入被接受字段，随后以 write-confirmed resume，终态 done", async () => {
    const { card, writes, resumes } = cardHarness();

    card.setAccepted("status", false);
    expect(card.snapshot().fields.map((f) => [f.field, f.accepted])).toEqual([
      ["amount", true],
      ["status", false],
    ]);

    await card.confirm();

    expect(writes).toEqual([{ amount: 250 }]);
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
    expect(card.snapshot().status).toBe("done");
    expect(card.snapshot().error).toBeNull();
  });

  test("全部忽略（rejectAll）：零写入，以 write-rejected resume，终态 rejected", async () => {
    const { card, writes, resumes } = cardHarness();

    await card.rejectAll();

    expect(writes).toEqual([]);
    expect(resumes).toEqual([{ kind: "write-rejected" }]);
    expect(card.snapshot().status).toBe("rejected");
  });

  test("逐个忽略所有字段后确认 = 全部忽略：零写入，走 write-rejected", async () => {
    const { card, writes, resumes } = cardHarness();

    card.setAccepted("amount", false);
    card.setAccepted("status", false);
    await card.confirm();

    expect(writes).toEqual([]);
    expect(resumes).toEqual([{ kind: "write-rejected" }]);
    expect(card.snapshot().status).toBe("rejected");
  });

  test("写入失败（含 PERMISSIONS 拒绝）：卡片保留、显示中文错误、不 resume；重试成功后 done", async () => {
    let failNext = true;
    const writes: Array<Record<string, unknown>> = [];
    const { card, resumes } = cardHarness({
      write: async (values) => {
        writes.push(values);
        if (failNext) {
          failNext = false;
          return { ok: false, message: "没有修改这条记录的权限" };
        }
        return { ok: true };
      },
    });

    await card.confirm();

    expect(card.snapshot().status).toBe("error");
    expect(card.snapshot().error).toBe("没有修改这条记录的权限");
    expect(card.snapshot().fields).toHaveLength(2);
    expect(resumes).toEqual([]);

    await card.confirm();

    expect(writes).toHaveLength(2);
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
    expect(card.snapshot().status).toBe("done");
    expect(card.snapshot().error).toBeNull();
  });

  test("写入成功但 resume 失败：不进入 done，错误可见且可重试", async () => {
    let failResume = true;
    const { card, resumes, writes } = cardHarness({
      resume: async (decision) => {
        if (failResume) {
          failResume = false;
          throw new Error("AI 会话续跑失败。");
        }
        resumes.push(decision);
      },
    });

    await card.confirm();

    expect(card.snapshot().status).toBe("error");
    expect(card.snapshot().error).toBe("AI 会话续跑失败。");

    await card.confirm();
    expect(resumes).toEqual([{ kind: "write-confirmed" }]);
    expect(writes).toHaveLength(1);
    expect(card.snapshot().status).toBe("done");
  });
});

describe("formatRowPatchValue — 卡片值展示", () => {
  test("空值显示为 —，数组用顿号连接，其余转字符串", () => {
    expect(formatRowPatchValue(null)).toBe("—");
    expect(formatRowPatchValue(undefined)).toBe("—");
    expect(formatRowPatchValue("")).toBe("—");
    expect(formatRowPatchValue(0)).toBe("0");
    expect(formatRowPatchValue(false)).toBe("false");
    expect(formatRowPatchValue(["ent_party:a", "ent_party:b"])).toBe("ent_party:a、ent_party:b");
    expect(formatRowPatchValue({ a: 1 })).toBe('{"a":1}');
    expect(formatRowPatchValue("已确认")).toBe("已确认");
  });
});
