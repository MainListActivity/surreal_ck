import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import type { GridColumnDef, RowPatchProposal } from "@surreal-ck/shared";
import type { SurrealConn } from "./surreal";
import { createRowPatchCard, formatRowPatchValue, writeRowPatch, type RowPatchCardState } from "./row-patch-card";

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
  proposal?: RowPatchProposal;
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
    const { card, resumes } = cardHarness({
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
    expect(card.snapshot().status).toBe("done");
  });
});

/** 仅实现写入路径用到的 SurrealConn 窄接口（与 workbook-data.test 同款）。 */
function fakeConn(over: Partial<SurrealConn> = {}): SurrealConn {
  let conn: SurrealConn;
  conn = {
    status: "connected",
    connect: async () => true,
    use: async () => ({}),
    close: async () => true,
    subscribe: () => () => {},
    query: async () => [],
    liveTable: async () => () => {},
    updateRecord: async (_id, patch) => patch,
    createRecord: async (_table, data) => data,
    deleteRecord: async () => ({}),
    transaction: async (run) => run(conn),
    ...over,
  } as SurrealConn;
  return conn;
}

const claimColumns: GridColumnDef[] = [
  { key: "amount", label: "金额", fieldType: "decimal" },
  { key: "due_date", label: "到期日", fieldType: "date" },
  { key: "debtor", label: "债务人", fieldType: "reference", referenceTable: "ent_party" },
];

const sheets = [{ id: "sheet:claims", tableName: "ent_claim", columns: claimColumns }];

describe("writeRowPatch — 复用 saveCells 的直连写入", () => {
  test("按 sheetId 找到目标表，向目标记录 MERGE 已接受字段；record/datetime 值经过边界包装", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = fakeConn({
      updateRecord: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return patch;
      },
    } as Partial<SurrealConn>);

    const result = await writeRowPatch({
      conn,
      sheets,
      sheetId: "sheet:claims",
      recordId: "ent_claim:one",
      values: { amount: 250, due_date: "2026-06-30", debtor: "ent_party:acme" },
    });

    expect(result).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe("ent_claim:one");
    expect(updates[0]?.patch.amount).toBe(250);
    // datetime：字符串在编辑器同一套 coerce 下变成 Date，SDK CBOR 边界包成 DateTime
    expect(updates[0]?.patch.due_date).toBeInstanceOf(Date);
    expect((updates[0]?.patch.due_date as Date).toISOString()).toBe(new Date("2026-06-30").toISOString());
    // record：内存 string，SDK 边界包成 StringRecordId
    expect(updates[0]?.patch.debtor).toBeInstanceOf(StringRecordId);
    expect(String(updates[0]?.patch.debtor)).toBe("ent_party:acme");
  });

  test("提案对应的 sheet 不在当前编辑器：返回中文错误，不发起写入", async () => {
    const updates: unknown[] = [];
    const conn = fakeConn({
      updateRecord: async (_id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        return patch;
      },
    } as Partial<SurrealConn>);

    const result = await writeRowPatch({
      conn,
      sheets,
      sheetId: "sheet:gone",
      recordId: "ent_claim:one",
      values: { amount: 250 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("数据表");
    expect(updates).toEqual([]);
  });

  test("引擎拒绝写入（PERMISSIONS）：错误经 describeWriteError 翻译为中文返回", async () => {
    const conn = fakeConn({
      updateRecord: async () => {
        throw new Error("There was a problem with the database: Not enough permissions");
      },
    } as Partial<SurrealConn>);

    const result = await writeRowPatch({
      conn,
      sheets,
      sheetId: "sheet:claims",
      recordId: "ent_claim:one",
      values: { amount: 250 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/[一-鿿]/);
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
