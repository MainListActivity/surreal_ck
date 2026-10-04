// 债权对账 · 利息重算接口（管理人浏览器直连）。
// 只读 claim_submission 申报行与固定规则版本；每次重算向 interest_calculation
// 追加一条不可变快照（表 PERMISSIONS 对记录会话禁 update/delete）。
// 计算失败返回明确错误且不写任何行；绝不改 creditor_roster / enterprise_ledger。

import { DateTime, StringRecordId } from "surrealdb";
import {
  calculateInterest,
  type ClaimsInterestErrorCode,
  type ClaimsInterestResult,
} from "@surreal-ck/shared/claims-interest";
import type { SurrealConn } from "./surreal";

export type ClaimSubmissionRow = {
  id: unknown;
  principal?: unknown;
  rate_segments?: unknown;
  interest_start?: unknown;
  interest_end?: unknown;
  interest_method?: unknown;
  penalty?: unknown;
};

export type InterestCalculationRow = {
  id: unknown;
  submission_id: unknown;
  rule_version: string;
  inputs: Record<string, unknown>;
  segments: Array<Record<string, unknown>>;
  days_total: number;
  total_interest: number;
  penalty_amount: number;
  total_amount: number;
  calculated_at: DateTime;
};

export type RecalculateFailure = {
  ok: false;
  error: { code: ClaimsInterestErrorCode | "submission-not-found"; message: string };
};

export type RecalculateResult =
  | { ok: true; calculation_id: string; result: Extract<ClaimsInterestResult, { ok: true }> }
  | RecalculateFailure;

function toDayIso(value: unknown): string | null {
  if (value instanceof DateTime) return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * 对一条债权人申报重算利息并保存快照。
 * 失败场景（缺起止日、空分段、截止日不晚于起息日等）返回错误，不落库。
 */
export async function recalculateSubmission(
  conn: SurrealConn,
  submissionId: string,
): Promise<RecalculateResult> {
  const rows = await conn.query<ClaimSubmissionRow>(
    `SELECT id, principal, rate_segments, interest_start, interest_end, interest_method, penalty
     FROM $submission;`,
    { submission: new StringRecordId(submissionId) },
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, error: { code: "submission-not-found", message: `claim_submission ${submissionId} 不存在` } };
  }

  const result = calculateInterest({
    principal: row.principal,
    rate_segments: row.rate_segments,
    interest_start: toDayIso(row.interest_start) ?? row.interest_start,
    interest_end: toDayIso(row.interest_end) ?? row.interest_end,
    interest_method: row.interest_method,
    penalty: row.penalty,
  });
  if (!result.ok) return result;

  const created = await conn.createRecord<InterestCalculationRow>("interest_calculation", {
    submission_id: new StringRecordId(submissionId),
    rule_version: result.rule_version,
    inputs: {
      principal: result.principal,
      rate_segments: Array.isArray(row.rate_segments) ? row.rate_segments : [],
      interest_start: result.interest_start,
      interest_end: result.interest_end,
      interest_method: result.interest_method,
      penalty: row.penalty ?? null,
    },
    segments: result.segments,
    days_total: result.days_total,
    total_interest: result.total_interest,
    penalty_amount: result.penalty_amount,
    total_amount: result.total_amount,
    calculated_at: new DateTime(new Date()),
  });

  return { ok: true, calculation_id: String(created.id), result };
}

/** 对账视图读取某条申报的历次重算快照（新→旧），历史行保持写入时的规则版本与分段。 */
export async function listInterestCalculations(
  conn: SurrealConn,
  submissionId: string,
): Promise<InterestCalculationRow[]> {
  return conn.query<InterestCalculationRow>(
    `SELECT id, submission_id, rule_version, inputs, segments,
            days_total, total_interest, penalty_amount, total_amount, calculated_at
     FROM interest_calculation
     WHERE submission_id = $submission
     ORDER BY calculated_at DESC;`,
    { submission: new StringRecordId(submissionId) },
  );
}

export type ClaimSubmissionListItem = {
  id: string;
  identity_code: string;
  status: string;
  principal: number | null;
  submitted_at: string | null;
};

/** 管理人对账入口：列出全部申报行（只读 claim_submission）。 */
export async function listClaimSubmissions(conn: SurrealConn): Promise<ClaimSubmissionListItem[]> {
  const rows = await conn.query<ClaimSubmissionRow & { identity_code?: unknown; status?: unknown; submitted_at?: unknown; created_at?: unknown }>(
    `SELECT id, identity_code, status, principal, submitted_at, created_at
     FROM claim_submission
     ORDER BY created_at DESC;`,
  );
  return rows.flatMap((row) => {
    const id = typeof row.id === "string" ? row.id : row.id ? String(row.id) : "";
    if (!id) return [];
    const submittedAt = row.submitted_at instanceof DateTime
      ? row.submitted_at.toDate().toISOString()
      : typeof row.submitted_at === "string" ? row.submitted_at : null;
    return [{
      id,
      identity_code: typeof row.identity_code === "string" ? row.identity_code : "",
      status: typeof row.status === "string" ? row.status : "unknown",
      principal: typeof row.principal === "number" ? row.principal : null,
      submitted_at: submittedAt,
    }];
  });
}

/**
 * 债权人门户「分段利率 JSON」输入解析：留空返回 null（走单段简表），
 * 非法 JSON / 非数组 / 空数组返回错误——原始值直传服务端，形状由引擎在校验时报具体错误。
 */
export function parseRateSegmentsJson(
  text: string,
): { ok: true; segments: Array<Record<string, unknown>> | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, segments: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "分段利率 JSON 无法解析" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "分段利率必须是 JSON 数组" };
  if (parsed.length === 0) return { ok: false, error: "分段利率数组不能为空" };
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "分段利率数组元素必须是对象" };
    }
  }
  return { ok: true, segments: parsed as Array<Record<string, unknown>> };
}
