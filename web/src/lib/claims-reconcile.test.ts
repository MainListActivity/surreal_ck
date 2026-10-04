import { describe, expect, test } from "bun:test";
import { DateTime, StringRecordId } from "surrealdb";
import {
  assembleReconciliation,
  buildReconciliationCsv,
  computeCategories,
  loadReconciliation,
  saveFinding,
  sendSupplementRequest,
  type AttachmentInput,
  type LedgerInput,
  type ReconRow,
  type RosterInput,
  type SubmissionInput,
} from "./claims-reconcile";
import type { InterestCalculationRow } from "./claims-interest";
import type { SurrealConn } from "./surreal";

// ── 夹具工厂（≥20 债权人，覆盖全部四类差异与组合）───────────────────────────

function roster(code: string, name = `债权人${code}`): RosterInput {
  return { id: `creditor_roster:${code}`, identity_code: code, name, subject_type: "enterprise" };
}

function ledger(code: string, principal: number, bookInterest: number): LedgerInput {
  return { id: `enterprise_ledger:${code}`, identity_code: code, principal, book_interest: bookInterest };
}

function submission(code: string, principal: number, penalty = 0): SubmissionInput {
  return {
    id: `claim_submission:${code}`,
    roster_id: `creditor_roster:${code}`,
    identity_code: code,
    principal,
    penalty,
    interest_method: "simple",
    status: "submitted",
  };
}

function calculation(code: string, totalInterest: number, penaltyAmount = 0): InterestCalculationRow {
  return {
    id: `interest_calculation:${code}-v1`,
    submission_id: new StringRecordId(`claim_submission:${code}`),
    rule_version: "interest-rules/v1",
    inputs: {},
    segments: [
      { index: 0, start: "2024-01-01", end: "2024-07-01", days: 182, base: 100000, annual_rate: 0.06, interest: 2991.78 },
      { index: 1, start: "2024-07-01", end: "2025-01-01", days: 184, base: 100000, annual_rate: 0.08, interest: 4032.88 },
    ],
    days_total: 366,
    total_interest: totalInterest,
    penalty_amount: penaltyAmount,
    total_amount: totalInterest + penaltyAmount,
    calculated_at: new DateTime("2025-01-15T00:00:00Z"),
  };
}

function attachment(code: string, type: string): AttachmentInput {
  return { id: `claim_attachment:${code}-${type}`, submission_id: `claim_submission:${code}`, attachment_type: type };
}

function find(rows: ReconRow[], code: string): ReconRow {
  const row = rows.find((r) => r.identity_code === code);
  if (!row) throw new Error(`fixture missing creditor ${code}`);
  return row;
}

/**
 * 21 位债权人全景：
 *  - C01–C06：三方一致（本金/利息/证据齐全）
 *  - D01–D05：金额差（申报本金 ≠ 账面本金）
 *  - I01–I05：利息差（重算利息 ≠ 账面利息，本金一致）
 *  - E01–E03：缺合同或证据（有申报无 contract 附件 / 名册无申报）
 *  - X01–X02：身份不符（账面识别码不在名册）
 */
function fixtureSet() {
  const rosterRows: RosterInput[] = [];
  const ledgerRows: LedgerInput[] = [];
  const submissionRows: SubmissionInput[] = [];
  const calcRows: InterestCalculationRow[] = [];
  const attachRows: AttachmentInput[] = [];

  for (let i = 1; i <= 6; i += 1) {
    const code = `C0${i}`;
    rosterRows.push(roster(code));
    ledgerRows.push(ledger(code, 100000 + i * 1000, 7024.66));
    submissionRows.push(submission(code, 100000 + i * 1000, i * 100));
    calcRows.push(calculation(code, 7024.66));
    attachRows.push(attachment(code, "contract"));
  }
  for (let i = 1; i <= 5; i += 1) {
    const code = `D0${i}`;
    rosterRows.push(roster(code));
    ledgerRows.push(ledger(code, 50000, 3000));
    submissionRows.push(submission(code, 50000 + i * 1000));
    calcRows.push(calculation(code, 3000));
    attachRows.push(attachment(code, "contract"));
  }
  for (let i = 1; i <= 5; i += 1) {
    const code = `I0${i}`;
    rosterRows.push(roster(code));
    ledgerRows.push(ledger(code, 80000, 3000 + i * 500));
    submissionRows.push(submission(code, 80000));
    calcRows.push(calculation(code, 3000));
    attachRows.push(attachment(code, "contract"));
  }
  // E01：申报在案但只有 judgment 附件，无 contract
  rosterRows.push(roster("E01"));
  ledgerRows.push(ledger("E01", 20000, 900));
  submissionRows.push(submission("E01", 20000));
  calcRows.push(calculation("E01", 900));
  attachRows.push(attachment("E01", "judgment"));
  // E02：申报在案但完全无附件
  rosterRows.push(roster("E02"));
  ledgerRows.push(ledger("E02", 20000, 900));
  submissionRows.push(submission("E02", 20000));
  calcRows.push(calculation("E02", 900));
  // E03：名册有债权人但无申报、无账面
  rosterRows.push(roster("E03"));
  // X01/X02：账面识别码不在名册
  ledgerRows.push(ledger("X01", 40000, 1500));
  ledgerRows.push(ledger("X02", 40000, 1600));
  // 多账面聚合：C06 再加一条（聚合后本金 106000→一致断言改为不一致不成立，单独验证聚合）
  ledgerRows.push(ledger("C06", 0, 0));

  return { roster: rosterRows, ledger: ledgerRows, submissions: submissionRows, calculations: calcRows, attachments: attachRows };
}

// ── 装配与四类差异 ──────────────────────────────────────────────────────────

describe("assembleReconciliation：21 位债权人四类差异", () => {
  const rows = assembleReconciliation(fixtureSet());

  test("行数 = 名册 ∪ 账面 ∪ 申报 的识别码并集（21）", () => {
    expect(rows).toHaveLength(21);
    const codes = new Set(rows.map((r) => r.identity_code));
    expect(codes.size).toBe(21);
  });

  test("一致行：6 行无任何差异类别", () => {
    for (let i = 1; i <= 5; i += 1) {
      expect(find(rows, `C0${i}`).categories).toEqual([]);
    }
  });

  test("金额差：D01–D05 只标 amount_mismatch", () => {
    for (let i = 1; i <= 5; i += 1) {
      const row = find(rows, `D0${i}`);
      expect(row.categories).toEqual(["amount_mismatch"]);
      expect(row.declared_principal).not.toBe(row.book_principal);
    }
  });

  test("利息差：I01–I05 只标 interest_mismatch（本金一致）", () => {
    for (let i = 1; i <= 5; i += 1) {
      const row = find(rows, `I0${i}`);
      expect(row.categories).toEqual(["interest_mismatch"]);
      expect(row.declared_principal).toBe(row.book_principal);
      expect(row.calculation!.total_interest).not.toBe(row.book_interest);
    }
  });

  test("缺证据：无 contract 附件 / 无附件 / 名册无申报", () => {
    expect(find(rows, "E01").categories).toEqual(["missing_evidence"]);
    expect(find(rows, "E02").categories).toEqual(["missing_evidence"]);
    expect(find(rows, "E03").categories).toEqual(["missing_evidence"]);
    expect(find(rows, "E03").submission_id).toBeNull();
  });

  test("身份不符：账面识别码不在名册 → identity_mismatch（且无申报 → 叠加缺证据）", () => {
    for (const code of ["X01", "X02"]) {
      const row = find(rows, code);
      expect(row.categories).toContain("identity_mismatch");
      expect(row.categories).toContain("missing_evidence");
      expect(row.name).toBeNull();
    }
  });

  test("多账面行按识别码聚合（C06 主行 106000+0 仍一致）", () => {
    const row = find(rows, "C06");
    expect(row.book_principal).toBe(106000 + 0);
    expect(row.categories).toEqual([]);
  });

  test("差异类别集合不含第五类", () => {
    const allowed = new Set(["amount_mismatch", "interest_mismatch", "missing_evidence", "identity_mismatch"]);
    for (const row of rows) {
      for (const c of row.categories) expect(allowed.has(c)).toBe(true);
    }
  });
});

describe("computeCategories 边界", () => {
  test("金额为 null 不可判定 → 不标 amount_mismatch", () => {
    expect(computeCategories({
      hasRoster: true, hasLedger: true,
      declaredPrincipal: null, bookPrincipal: 50000,
      bookInterest: 100, recalcInterest: 100,
      hasSubmission: true, hasContractAttachment: true,
    })).toEqual([]);
  });

  test("无重算快照 → 不标 interest_mismatch", () => {
    expect(computeCategories({
      hasRoster: true, hasLedger: true,
      declaredPrincipal: 1, bookPrincipal: 1,
      bookInterest: 999, recalcInterest: null,
      hasSubmission: true, hasContractAttachment: true,
    })).toEqual([]);
  });

  test("分以下差异（≤0.005）不算差", () => {
    expect(computeCategories({
      hasRoster: true, hasLedger: true,
      declaredPrincipal: 50000.004, bookPrincipal: 50000,
      bookInterest: 100.005, recalcInterest: 100,
      hasSubmission: true, hasContractAttachment: true,
    })).toEqual([]);
  });
});

describe("快照选择", () => {
  test("同一申报多条快照取最新 calculated_at", () => {
    const base = calculation("C01", 100);
    const newer = { ...calculation("C01", 200), id: "interest_calculation:C01-v2", calculated_at: new DateTime("2025-02-01T00:00:00Z") };
    const rows = assembleReconciliation({
      roster: [roster("C01")],
      ledger: [ledger("C01", 50000, 200)],
      submissions: [submission("C01", 50000)],
      calculations: [base, newer],
      attachments: [attachment("C01", "contract")],
    });
    const row = find(rows, "C01");
    expect(row.calculation!.total_interest).toBe(200);
    expect(row.categories).toEqual([]);
  });
});

// ── CSV 导出 ────────────────────────────────────────────────────────────────

describe("buildReconciliationCsv", () => {
  const data = fixtureSet();
  const rows = assembleReconciliation(data);

  test("行数 = 债权人行数 + 表头；含 BOM", () => {
    const csv = buildReconciliationCsv(rows, []);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines.length).toBe(rows.length + 1);
    expect(lines[0]).toContain("识别码");
    expect(lines[0]).toContain("规则版本");
  });

  test("行内容：债权人 / 三类金额 / 差异类别 / 结论 / 规则版本", () => {
    const csv = buildReconciliationCsv(rows, [{
      identity_code: "D01",
      state: "waiting_creditor",
      manager_note: "账面 50000 与申报 51000 不符，请补银行流水",
      categories: ["amount_mismatch"],
    }]);
    const lines = csv.trimEnd().split("\r\n");
    const d01 = lines.find((l) => l.startsWith("D01,"))!;
    expect(d01).toContain("50000.00");
    expect(d01).toContain("51000.00");
    expect(d01).toContain("3000.00");
    expect(d01).toContain("金额差");
    expect(d01).toContain("等待债权人补充");
    expect(d01).toContain("interest-rules/v1");
    const c01 = lines.find((l) => l.startsWith("C01,"))!;
    expect(c01).toContain("7024.66");
  });

  test("字段含逗号/引号/换行被正确转义", () => {
    const csv = buildReconciliationCsv(rows, [{
      identity_code: "C01",
      state: "resolved",
      manager_note: '含"引号", 与\n换行',
      categories: [],
    }]);
    const c01 = csv.trimEnd().split("\r\n").find((l) => l.startsWith("C01,"))!;
    expect(c01).toContain('"含""引号"", 与\n换行"');
  });
});

// ── 直连读写（fakeConn）────────────────────────────────────────────────────

type Call = { kind: "query"; sql: string; vars?: Record<string, unknown> } | { kind: "create"; table: string; data: Record<string, unknown> };

function fakeConn(handler?: (sql: string) => Record<string, unknown>[]): { conn: SurrealConn; calls: Call[] } {
  const calls: Call[] = [];
  const conn = {
    async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
      calls.push({ kind: "query", sql, vars });
      return (handler?.(sql) ?? []) as T[];
    },
    async createRecord<T>(table: string, data: Record<string, unknown>): Promise<T> {
      calls.push({ kind: "create", table, data });
      return { id: "claim_supplement:sp1", ...data } as T;
    },
  } as unknown as SurrealConn;
  return { conn, calls };
}

describe("loadReconciliation", () => {
  test("并行读 7 张表并装配", async () => {
    const data = fixtureSet();
    const { conn, calls } = fakeConn((sql) => {
      if (sql.includes("FROM creditor_roster")) return data.roster;
      if (sql.includes("FROM enterprise_ledger")) return data.ledger;
      if (sql.includes("FROM claim_submission")) return data.submissions;
      if (sql.includes("FROM interest_calculation")) return data.calculations;
      if (sql.includes("FROM claim_attachment")) return data.attachments;
      return [];
    });
    const result = await loadReconciliation(conn);
    expect(result.rows).toHaveLength(21);
    expect(calls.filter((c) => c.kind === "query")).toHaveLength(7);
  });
});

describe("saveFinding", () => {
  test("identity_code 唯一 UPSERT，保留结论状态与操作者", async () => {
    const { conn, calls } = fakeConn();
    await saveFinding(conn, {
      identity_code: "D01",
      categories: ["amount_mismatch"],
      manager_note: "需补流水",
      state: "waiting_creditor",
      linked_submission_id: "claim_submission:D01",
      updated_by: "王管理人",
    });
    const query = calls.find((c) => c.kind === "query")!;
    expect(query.sql).toContain("INSERT INTO reconciliation_finding");
    expect(query.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(query.vars!.identityCode).toBe("D01");
    expect(query.vars!.categories).toEqual(["amount_mismatch"]);
    expect(query.vars!.updatedBy).toBe("王管理人");
    expect(String(query.vars!.linkedSubmissionId)).toBe("claim_submission:D01");
  });

  test("空 note / 无申报写 NONE", async () => {
    const { conn, calls } = fakeConn();
    await saveFinding(conn, {
      identity_code: "C01",
      categories: [],
      manager_note: null,
      state: "resolved",
      updated_by: "王管理人",
    });
    const query = calls.find((c) => c.kind === "query")!;
    expect(query.vars!.managerNote).toBeUndefined();
    expect(query.vars!.linkedSubmissionId).toBeUndefined();
  });
});

describe("sendSupplementRequest", () => {
  test("追加 manager_request 行：direction/actor/body 落库", async () => {
    const { conn, calls } = fakeConn();
    const created = await sendSupplementRequest(conn, {
      submission_id: "claim_submission:D01",
      body: "  请补充 2024 年银行流水  ",
      actor: "王管理人",
    });
    const create = calls.find((c) => c.kind === "create")!;
    expect(create.table).toBe("claim_supplement");
    expect(create.data.direction).toBe("manager_request");
    expect(create.data.body).toBe("请补充 2024 年银行流水");
    expect(create.data.actor).toBe("王管理人");
    expect(String(create.data.submission_id)).toBe("claim_submission:D01");
    expect(create.data.created_at).toBeInstanceOf(DateTime);
    expect(created.id).toBe("claim_supplement:sp1");
  });

  test("空文本与超长文本拒绝", async () => {
    const { conn } = fakeConn();
    await expect(sendSupplementRequest(conn, { submission_id: "claim_submission:D01", body: "   ", actor: "x" })).rejects.toThrow("1–4000");
    await expect(sendSupplementRequest(conn, { submission_id: "claim_submission:D01", body: "x".repeat(4001), actor: "x" })).rejects.toThrow("1–4000");
  });
});
