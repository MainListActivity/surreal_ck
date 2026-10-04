// 债权对账：三列并排（债权人申报 / 企业账面 / 系统重算）、四类差异、
// 差异结论与补充往返、CSV 导出。全部浏览器直连；差异判定为确定性纯函数，
// 金额比较以「分」为粒度（|差| > 0.005 视为不一致），不引入浮点歧义。
// 四类差异枚举与 docs/claims-reconciliation/data-model.md 一致，不允许第五类。

import { DateTime, StringRecordId } from "surrealdb";
import type { InterestCalculationRow } from "./claims-interest";
import type { SurrealConn } from "./surreal";

export type ReconCategory =
  | "amount_mismatch"
  | "interest_mismatch"
  | "missing_evidence"
  | "identity_mismatch";

export const RECON_CATEGORY_LABELS: Record<ReconCategory, string> = {
  amount_mismatch: "金额差",
  interest_mismatch: "利息差",
  missing_evidence: "缺合同或证据",
  identity_mismatch: "身份不符",
};

export const FINDING_STATE_LABELS: Record<string, string> = {
  open: "待处理",
  waiting_creditor: "等待债权人补充",
  resolved: "已结论",
};

const CENT = 0.005;

export type RosterInput = {
  id?: unknown;
  identity_code?: unknown;
  name?: unknown;
  subject_type?: unknown;
};

export type LedgerInput = {
  id?: unknown;
  identity_code?: unknown;
  principal?: unknown;
  book_interest?: unknown;
};

export type SubmissionInput = {
  id?: unknown;
  roster_id?: unknown;
  identity_code?: unknown;
  principal?: unknown;
  penalty?: unknown;
  interest_start?: unknown;
  interest_end?: unknown;
  interest_method?: unknown;
  status?: unknown;
};

export type AttachmentInput = {
  id?: unknown;
  submission_id?: unknown;
  attachment_type?: unknown;
};

/** 某一债权人的三列并排视图。 */
export type ReconRow = {
  identity_code: string;
  name: string | null;
  subject_type: string | null;
  roster_id: string | null;
  submission_id: string | null;
  /** 申报列：本金 / 违约金 / 申报状态。 */
  declared_principal: number | null;
  declared_penalty: number | null;
  declared_status: string | null;
  /** 账面列：多条账面按识别码聚合求和。 */
  book_principal: number | null;
  book_interest: number | null;
  /** 重算列：最新一条 interest_calculation 快照（无快照则全 null）。 */
  calculation: InterestCalculationRow | null;
  attachments: { id: string; attachment_type: string | null }[];
  categories: ReconCategory[];
};

export type ReconFinding = {
  id?: unknown;
  identity_code?: unknown;
  categories?: unknown;
  manager_note?: unknown;
  state?: unknown;
  linked_submission_id?: unknown;
  updated_by?: unknown;
  updated_at?: unknown;
};

export type ClaimSupplement = {
  id?: unknown;
  submission_id?: unknown;
  direction?: unknown;
  body?: unknown;
  actor?: unknown;
  created_at?: unknown;
};

function idStr(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && "toString" in value) {
    const s = String(value);
    return s.length > 0 ? s : null;
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function differs(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) > CENT;
}

/** 四类差异判定（纯函数）。规则与 data-model.md 对齐；不可判定的项不强行归类。 */
export function computeCategories(input: {
  hasRoster: boolean;
  hasLedger: boolean;
  declaredPrincipal: number | null;
  bookPrincipal: number | null;
  bookInterest: number | null;
  recalcInterest: number | null;
  hasSubmission: boolean;
  hasContractAttachment: boolean;
}): ReconCategory[] {
  const categories: ReconCategory[] = [];
  // 身份不符：账面识别码对不上名册（导入期应已拒绝，历史数据仍可能出现）。
  if (input.hasLedger && !input.hasRoster) categories.push("identity_mismatch");
  // 金额差：申报本金与账面本金（聚合）不一致。申报本金缺失时不判。
  if (differs(input.declaredPrincipal, input.bookPrincipal)) categories.push("amount_mismatch");
  // 利息差：系统重算合计利息与账面利息（聚合）不一致。无快照时不判。
  if (differs(input.recalcInterest, input.bookInterest)) categories.push("interest_mismatch");
  // 缺合同或证据：有申报但无 contract 类附件；或无申报（名册/账面上的债权人未交材料）。
  if (input.hasSubmission ? !input.hasContractAttachment : true) {
    categories.push("missing_evidence");
  }
  return categories;
}

function latestCalculation(
  calculations: InterestCalculationRow[],
  bySubmission: Map<string, InterestCalculationRow>,
): void {
  for (const calc of calculations) {
    const key = idStr(calc.submission_id);
    if (!key) continue;
    const prev = bySubmission.get(key);
    const ts = (c: InterestCalculationRow): number => {
      const v = c.calculated_at;
      if (v instanceof DateTime) return v.toDate().getTime();
      const ms = Date.parse(String(v));
      return Number.isNaN(ms) ? 0 : ms;
    };
    if (!prev || ts(calc) >= ts(prev)) bySubmission.set(key, calc);
  }
}

/** 按识别码把名册/账面/申报/快照/附件装配为三列并排行（纯函数）。 */
export function assembleReconciliation(input: {
  roster: RosterInput[];
  ledger: LedgerInput[];
  submissions: SubmissionInput[];
  calculations: InterestCalculationRow[];
  attachments: AttachmentInput[];
}): ReconRow[] {
  const rosterByCode = new Map<string, RosterInput>();
  for (const r of input.roster) {
    const code = text(r.identity_code);
    if (code) rosterByCode.set(code, r);
  }
  const ledgerByCode = new Map<string, { principal: number; book_interest: number; count: number }>();
  for (const l of input.ledger) {
    const code = text(l.identity_code);
    if (!code) continue;
    const agg = ledgerByCode.get(code) ?? { principal: 0, book_interest: 0, count: 0 };
    agg.principal += num(l.principal) ?? 0;
    agg.book_interest += num(l.book_interest) ?? 0;
    agg.count += 1;
    ledgerByCode.set(code, agg);
  }
  const submissionByCode = new Map<string, SubmissionInput>();
  const submissionCode = new Map<string, string>();
  for (const s of input.submissions) {
    const code = text(s.identity_code);
    const id = idStr(s.id);
    if (!code || !id) continue;
    submissionByCode.set(code, s);
    submissionCode.set(id, code);
  }
  const calcBySubmission = new Map<string, InterestCalculationRow>();
  latestCalculation(input.calculations, calcBySubmission);
  const attachBySubmission = new Map<string, { id: string; attachment_type: string | null }[]>();
  for (const a of input.attachments) {
    const sub = idStr(a.submission_id);
    const id = idStr(a.id);
    if (!sub || !id) continue;
    const list = attachBySubmission.get(sub) ?? [];
    list.push({ id, attachment_type: text(a.attachment_type) });
    attachBySubmission.set(sub, list);
  }

  const codes = new Set<string>([
    ...rosterByCode.keys(),
    ...ledgerByCode.keys(),
    ...submissionByCode.keys(),
  ]);

  const rows: ReconRow[] = [];
  for (const code of codes) {
    const roster = rosterByCode.get(code);
    const ledger = ledgerByCode.get(code);
    const submission = submissionByCode.get(code);
    const submissionId = submission ? idStr(submission.id) : null;
    const calc = submissionId ? calcBySubmission.get(submissionId) ?? null : null;
    const attachments = submissionId ? attachBySubmission.get(submissionId) ?? [] : [];
    const row: ReconRow = {
      identity_code: code,
      name: text(roster?.name),
      subject_type: text(roster?.subject_type),
      roster_id: roster ? idStr(roster.id) : null,
      submission_id: submissionId,
      declared_principal: num(submission?.principal),
      declared_penalty: num(submission?.penalty),
      declared_status: text(submission?.status),
      book_principal: ledger ? Math.round(ledger.principal * 100) / 100 : null,
      book_interest: ledger ? Math.round(ledger.book_interest * 100) / 100 : null,
      calculation: calc,
      attachments,
      categories: [],
    };
    row.categories = computeCategories({
      hasRoster: roster !== undefined,
      hasLedger: ledger !== undefined,
      declaredPrincipal: row.declared_principal,
      bookPrincipal: row.book_principal,
      bookInterest: row.book_interest,
      recalcInterest: calc ? num(calc.total_interest) : null,
      hasSubmission: submission !== undefined,
      hasContractAttachment: attachments.some((a) => a.attachment_type === "contract"),
    });
    rows.push(row);
  }
  rows.sort((a, b) => a.identity_code.localeCompare(b.identity_code, "zh-Hans-CN"));
  return rows;
}

// ── 直连读写 ──────────────────────────────────────────────────────────────

/** 载入对账所需全部行（只读名册/账面/申报/快照/附件/结论/往返）。 */
export async function loadReconciliation(conn: SurrealConn): Promise<{
  rows: ReconRow[];
  findings: ReconFinding[];
  supplements: ClaimSupplement[];
}> {
  const [roster, ledger, submissions, calculations, attachments, findings, supplements] = await Promise.all([
    conn.query<RosterInput>(`SELECT id, identity_code, name, subject_type FROM creditor_roster;`),
    conn.query<LedgerInput>(`SELECT id, identity_code, principal, book_interest FROM enterprise_ledger;`),
    conn.query<SubmissionInput>(
      `SELECT id, roster_id, identity_code, principal, penalty,
              interest_start, interest_end, interest_method, status
       FROM claim_submission;`,
    ),
    conn.query<InterestCalculationRow>(
      `SELECT id, submission_id, rule_version, inputs, segments,
              days_total, total_interest, penalty_amount, total_amount, calculated_at
       FROM interest_calculation;`,
    ),
    conn.query<AttachmentInput>(`SELECT id, submission_id, attachment_type FROM claim_attachment;`),
    conn.query<ReconFinding>(
      `SELECT id, identity_code, categories, manager_note, state, linked_submission_id, updated_by, updated_at
       FROM reconciliation_finding;`,
    ),
    conn.query<ClaimSupplement>(
      `SELECT id, submission_id, direction, body, actor, created_at
       FROM claim_supplement
       ORDER BY created_at ASC, id ASC;`,
    ),
  ]);
  return {
    rows: assembleReconciliation({ roster, ledger, submissions, calculations, attachments }),
    findings,
    supplements,
  };
}

export type FindingPatch = {
  identity_code: string;
  categories: ReconCategory[];
  manager_note: string | null;
  state: "open" | "waiting_creditor" | "resolved";
  linked_submission_id?: string | null;
  updated_by: string | null;
};

/** 保存/更新某债权人的差异结论（identity_code 唯一，UPSERT 语义）。 */
export async function saveFinding(conn: SurrealConn, patch: FindingPatch): Promise<void> {
  await conn.query(
    `INSERT INTO reconciliation_finding {
       identity_code: $identityCode,
       categories: $categories,
       manager_note: $managerNote,
       state: $state,
       linked_submission_id: $linkedSubmissionId,
       updated_by: $updatedBy
     }
     ON DUPLICATE KEY UPDATE
       categories = $categories,
       manager_note = $managerNote,
       state = $state,
       linked_submission_id = $linkedSubmissionId,
       updated_by = $updatedBy,
       updated_at = time::now();`,
    {
      identityCode: patch.identity_code,
      categories: patch.categories,
      managerNote: patch.manager_note === null ? undefined : patch.manager_note,
      state: patch.state,
      linkedSubmissionId: patch.linked_submission_id
        ? new StringRecordId(patch.linked_submission_id)
        : undefined,
      updatedBy: patch.updated_by === null ? undefined : patch.updated_by,
    },
  );
}

/** 管理人向债权人发出补充要求（追加式，不可改删）。 */
export async function sendSupplementRequest(
  conn: SurrealConn,
  input: { submission_id: string; body: string; actor: string },
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > 4000) {
    throw new Error("补充要求需为 1–4000 字");
  }
  const created = await conn.createRecord<{ id: unknown }>("claim_supplement", {
    submission_id: new StringRecordId(input.submission_id),
    direction: "manager_request",
    body,
    actor: input.actor,
    created_at: new DateTime(new Date()),
  });
  return { id: idStr(created.id) ?? "" };
}

// ── CSV 导出 ────────────────────────────────────────────────────────────────

const CSV_HEADER = [
  "识别码", "债权人名称", "主体类型",
  "申报本金", "申报违约金", "申报状态",
  "账面本金", "账面利息",
  "重算利息", "重算违约金", "重算合计", "规则版本",
  "差异类别", "结论状态", "管理人结论",
];

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function money(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/** 导出对账结果 CSV（UTF-8 BOM，Excel 可直接打开；行数 = 债权人行数）。 */
export function buildReconciliationCsv(
  rows: ReconRow[],
  findings: ReconFinding[],
): string {
  const findingByCode = new Map<string, ReconFinding>();
  for (const f of findings) {
    const code = text(f.identity_code);
    if (code) findingByCode.set(code, f);
  }
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const row of rows) {
    const finding = findingByCode.get(row.identity_code);
    const calc = row.calculation;
    lines.push([
      row.identity_code,
      row.name,
      row.subject_type,
      money(row.declared_principal),
      money(row.declared_penalty),
      row.declared_status,
      money(row.book_principal),
      money(row.book_interest),
      money(calc ? num(calc.total_interest) : null),
      money(calc ? num(calc.penalty_amount) : null),
      money(calc ? num(calc.total_amount) : null),
      calc?.rule_version ?? null,
      row.categories.map((c) => RECON_CATEGORY_LABELS[c]).join("；"),
      finding ? FINDING_STATE_LABELS[text(finding.state) ?? ""] ?? text(finding.state) : null,
      text(finding?.manager_note),
    ].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
