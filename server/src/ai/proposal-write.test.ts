/**
 * 提案确认写的事务内执行体（PG-1）。
 *
 * 与「浏览器直连写」同口径，因此这里钉的是**行为契约**而非实现细节：
 * - 未勾选的字段绝不写入（只写 values 里的键）；
 * - 与现值相同的字段不进 patch（最小 patch 与手工编辑一致）；
 * - 校验 / 未知字段 / 目标不可见一律抛具名 HttpError —— 抛错即回滚，
 *   连同栅栏消费一起撤销，卡片可重试。
 */
import { describe, expect, test } from "bun:test";
import { proposalWriteTargetFrom, writeProposalValues } from "./proposal-write";

type QueryCall = { sql: string; vars: Record<string, unknown> };

/** 顺序应答的事务桩；每次 query 记下方言与参数供断言。 */
function tx(responses: unknown[]) {
  const calls: QueryCall[] = [];
  let index = 0;
  return {
    calls,
    tx: {
      async query(sql: string, vars?: Record<string, unknown>) {
        calls.push({ sql, vars: vars ?? {} });
        return responses[index++] ?? [];
      },
    } as never,
  };
}

const SHEET_ROW = [[{
  id: "sheet:s1",
  table_name: "p1",
  column_defs: [
    // column_defs 存的是 snake_case 存储形态（storedColumnToDTO 负责转成 DTO）。
    { key: "field_1", label: "field 1", field_type: "checkbox" },
    { key: "field_2", label: "field 2", field_type: "text" },
  ],
}]];

describe("proposalWriteTargetFrom", () => {
  test("row-patch 一律映射成 patch 目标", () => {
    expect(proposalWriteTargetFrom({
      type: "row-patch-proposal",
      sheetId: "sheet:s1",
      recordId: "p1:v1",
      proposals: [],
    })).toEqual({ sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" });
  });

  test("record-write 的 create / update 分别映射，create 不带 recordId", () => {
    expect(proposalWriteTargetFrom({
      type: "record-write-proposal",
      operation: "create",
      sheetId: "sheet:s1",
      proposals: [],
    })).toEqual({ sheetId: "sheet:s1", operation: "create" });

    expect(proposalWriteTargetFrom({
      type: "record-write-proposal",
      operation: "update",
      sheetId: "sheet:s1",
      recordId: "p1:v1",
      proposals: [],
    })).toEqual({ sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" });
  });
});

describe("writeProposalValues", () => {
  test("部分接受：只写勾选的字段，未勾选字段不出现在 patch 里", async () => {
    const { calls, tx: session } = tx([
      SHEET_ROW,
      [[{ id: "p1:v1", field_1: true, field_2: "原值" }]],
    ]);

    const outcome = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" },
      values: { field_1: false },
    });

    expect(outcome.created).toBe(false);
    // field_1 由 true 改 false → 进 patch；field_2 未勾选，既不在 patch 里也不被 SELECT 之外的写触达。
    expect(Object.keys(outcome.written)).toEqual(["field_1"]);
    const update = calls.at(-1)!;
    expect(update.sql).toContain("UPDATE $record MERGE $patch");
    expect(Object.keys(update.vars.patch as Record<string, unknown>)).toEqual(["field_1"]);
  });

  test("勾选的值与现值相同 → 零写入（不 MERGE 空 patch）", async () => {
    const { calls, tx: session } = tx([
      SHEET_ROW,
      [[{ id: "p1:v1", field_1: true }]],
    ]);

    const outcome = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" },
      values: { field_1: true },
    });

    expect(outcome).toEqual({ written: {}, created: false });
    expect(calls.some((call) => call.sql.includes("UPDATE"))).toBe(false);
  });

  test("未知字段 → 具名 422，调用方据此整笔回滚（含栅栏消费）", async () => {
    const { tx: session } = tx([SHEET_ROW]);
    const error = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" },
      values: { field_1: true, 并不存在的字段: 1 },
    }).catch((e) => e);

    expect((error as { status: number }).status).toBe(422);
    expect((error as { code: string }).code).toBe("chat-write-unknown-field");
  });

  test("目标 sheet 不可见 → 403，不泄露他人 sheet 存在性", async () => {
    const { tx: session } = tx([[]]);
    const error = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" },
      values: { field_1: true },
    }).catch((e) => e);
    expect((error as { status: number }).status).toBe(403);
    expect((error as { code: string }).code).toBe("chat-write-target-unavailable");
  });

  test("目标记录不存在 → 404（区别于「不可见」，避免把权限问题报成数据问题）", async () => {
    const { tx: session } = tx([SHEET_ROW, []]);
    const error = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", recordId: "p1:missing", operation: "patch" },
      values: { field_1: true },
    }).catch((e) => e);
    expect((error as { status: number }).status).toBe(404);
    expect((error as { code: string }).code).toBe("chat-write-record-missing");
  });

  test("sheetId 形不成 record id → 400（先于任何查询）", async () => {
    const { calls, tx: session } = tx([]);
    const error = await writeProposalValues(session, {
      target: { sheetId: "not-a-record-id", operation: "patch" },
      values: { field_1: true },
    }).catch((e) => e);
    expect((error as { status: number }).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("create：直接 CREATE 并回传新记录 id", async () => {
    const { calls, tx: session } = tx([SHEET_ROW, [[{ id: "p1:new" }]]]);
    const outcome = await writeProposalValues(session, {
      target: { sheetId: "sheet:s1", operation: "create" },
      values: { field_2: "新行" },
    });
    expect(outcome.created).toBe(true);
    expect(outcome.createdRecordId).toBe("p1:new");
    expect(calls.at(-1)!.sql).toContain("CREATE type::table($table) CONTENT $content");
  });
});