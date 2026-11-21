export const CLAIM_PROGRESS_LABELS = {
  submitted: "已提交",
  accepted: "已受理",
  needs_info: "待补正",
  under_review: "审查中",
  decision_published: "已出结论",
  objected: "有异议",
  final: "已确认",
} as const;

export type ClaimProgressStage = keyof typeof CLAIM_PROGRESS_LABELS;

export type PublishedClaimDecision = {
  version: number;
  confirmedPrincipal: number;
  confirmedInterest: number;
  confirmedPenalty: number;
  unconfirmedAmount: number;
  reason: string;
  publishedAt: string;
};

export function claimProgressStage(value: unknown): ClaimProgressStage | null {
  return typeof value === "string" && Object.hasOwn(CLAIM_PROGRESS_LABELS, value)
    ? value as ClaimProgressStage
    : null;
}

export function publicClaimStage(value: unknown, submissionStatus: unknown): ClaimProgressStage | null {
  const current = claimProgressStage(value);
  if (current) return current;
  if (submissionStatus === "closed") return "final";
  if (submissionStatus === "submitted" || submissionStatus === "needs_info") return submissionStatus;
  return null;
}

export type ClaimProgressEvent = {
  stage: ClaimProgressStage;
  createdAt: string;
  actor: "本人" | "管理人";
};

export function claimCsvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  const formulaPrefix = typeof value === "string"
    && (/^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value) || /^[\r\n\t]/u.test(value));
  const safe = formulaPrefix ? `'${text}` : text;
  return /[",\n\r]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
