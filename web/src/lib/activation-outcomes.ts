import type { ActivationSummaryV2 } from "@surreal-ck/shared";
import type { DateTime } from "surrealdb";
import { recordIdString, recordIdStrings } from "./record-id";
import type { SurrealConn } from "./surreal";

type EvidenceGroup<T> = { available: true; rows: T[] } | { available: false; rows: [] };
type UserEvidence = { id: string; lastSeenAt: string | null };
type WorkbookEvidence = { id: string };
type ImportEvidence = { id: string; workbookId: string | null; status: string; startedAt: string; completedAt: string | null };
type ImportRowEvidence = { batchId: string; status: string };
type RunEvidence = { id: string; workbookId: string; status: string; findingCount: number; startedAt: string };
type FindingEvidence = { id: string; workbookId: string; runHistory: string[]; status: string };
type AssignmentEvidence = { id: string; findingIds: string[]; assigneeId: string; reviewerId: string; status: string; reviewedAt: string | null };
type AssignmentEventEvidence = { assignmentId: string; actorId: string; kind: string };
type ActivityEvidence = { verb: string; createdAt: string };

export type ActivationEvidence = {
  users: EvidenceGroup<UserEvidence>;
  workbooks: EvidenceGroup<WorkbookEvidence>;
  imports: EvidenceGroup<ImportEvidence>;
  importRows: EvidenceGroup<ImportRowEvidence>;
  runs: EvidenceGroup<RunEvidence>;
  findings: EvidenceGroup<FindingEvidence>;
  assignments: EvidenceGroup<AssignmentEvidence>;
  assignmentEvents: EvidenceGroup<AssignmentEventEvidence>;
  activities: EvidenceGroup<ActivityEvidence>;
};

type StoredUser = { id: unknown; last_seen_at?: DateTime };
type StoredWorkbook = { id: unknown };
type StoredImport = { id: unknown; workbook?: unknown; status?: unknown; started_at?: DateTime; completed_at?: DateTime };
type StoredImportRow = { batch?: unknown; status?: unknown };
type StoredRun = { id: unknown; workbook?: unknown; status?: unknown; finding_count?: unknown; started_at?: DateTime };
type StoredFinding = { id: unknown; workbook?: unknown; run_history?: unknown; status?: unknown };
type StoredAssignment = { id: unknown; findings?: unknown; assignee?: unknown; reviewer?: unknown; status?: unknown; reviewed_at?: DateTime };
type StoredAssignmentEvent = { assignment?: unknown; actor?: unknown; kind?: unknown };
type StoredActivity = { verb?: unknown; created_at?: DateTime };
const recordIds = (value: unknown): string[] => recordIdStrings(value);
const dateTimeIso = (value: DateTime | null | undefined): string | null => value ? value.toDate().toISOString() : null;

async function loadEvidenceGroup<T>(load: () => Promise<T[]>): Promise<EvidenceGroup<T>> {
  try { return { available: true, rows: await load() }; }
  catch { return { available: false, rows: [] }; }
}

export async function loadActivationEvidence(conn: SurrealConn): Promise<ActivationEvidence> {
  const [users, workbooks, imports, importRows, runs, findings, assignments, assignmentEvents, activities] = await Promise.all([
    loadEvidenceGroup(async () => (await conn.query<StoredUser>("SELECT id, last_seen_at FROM user WHERE kind = 'human' AND disabled_at = NONE")).map((row) => ({ id: recordIdString(row.id) ?? "", lastSeenAt: dateTimeIso(row.last_seen_at) }))),
    loadEvidenceGroup(async () => (await conn.query<StoredWorkbook>("SELECT id FROM workbook")).map((row) => ({ id: recordIdString(row.id) ?? "" }))),
    loadEvidenceGroup(async () => (await conn.query<StoredImport>("SELECT id, workbook, status, started_at, completed_at FROM import_batch")).map((row) => ({ id: recordIdString(row.id) ?? "", workbookId: recordIdString(row.workbook), status: String(row.status ?? ""), startedAt: dateTimeIso(row.started_at) ?? "", completedAt: dateTimeIso(row.completed_at) }))),
    loadEvidenceGroup(async () => (await conn.query<StoredImportRow>("SELECT batch, status FROM import_batch_row")).map((row) => ({ batchId: recordIdString(row.batch) ?? "", status: String(row.status ?? "") }))),
    loadEvidenceGroup(async () => (await conn.query<StoredRun>("SELECT id, workbook, status, finding_count, started_at FROM data_check_run")).map((row) => ({ id: recordIdString(row.id) ?? "", workbookId: recordIdString(row.workbook) ?? "", status: String(row.status ?? ""), findingCount: Number(row.finding_count ?? 0), startedAt: dateTimeIso(row.started_at) ?? "" }))),
    loadEvidenceGroup(async () => (await conn.query<StoredFinding>("SELECT id, workbook, run_history, status FROM data_check_finding")).map((row) => ({ id: recordIdString(row.id) ?? "", workbookId: recordIdString(row.workbook) ?? "", runHistory: recordIds(row.run_history), status: String(row.status ?? "") }))),
    loadEvidenceGroup(async () => (await conn.query<StoredAssignment>("SELECT id, findings, assignee, reviewer, status, reviewed_at FROM finding_assignment")).map((row) => ({ id: recordIdString(row.id) ?? "", findingIds: recordIds(row.findings), assigneeId: recordIdString(row.assignee) ?? "", reviewerId: recordIdString(row.reviewer) ?? "", status: String(row.status ?? ""), reviewedAt: dateTimeIso(row.reviewed_at) }))),
    loadEvidenceGroup(async () => (await conn.query<StoredAssignmentEvent>("SELECT assignment, actor, kind FROM finding_assignment_event WHERE actor.kind = 'human'")).map((row) => ({ assignmentId: recordIdString(row.assignment) ?? "", actorId: recordIdString(row.actor) ?? "", kind: String(row.kind ?? "") }))),
    loadEvidenceGroup(async () => (await conn.query<StoredActivity>("SELECT verb, created_at FROM activity_event WHERE verb = 'record.write'")).map((row) => ({ verb: String(row.verb ?? ""), createdAt: dateTimeIso(row.created_at) ?? "" }))),
  ]);
  return { users, workbooks, imports, importRows, runs, findings, assignments, assignmentEvents, activities };
}

function evidencePeriod(evidence: ActivationEvidence, now: Date, timeZone: string) {
  const timestamps = [
    ...evidence.users.rows.flatMap((item) => item.lastSeenAt ?? []),
    ...evidence.imports.rows.flatMap((item) => [item.startedAt, ...(item.completedAt ? [item.completedAt] : [])]),
    ...evidence.runs.rows.map((item) => item.startedAt),
    ...evidence.assignments.rows.flatMap((item) => item.reviewedAt ?? []),
    ...evidence.activities.rows.map((item) => item.createdAt),
  ].filter((value) => !Number.isNaN(Date.parse(value))).sort();
  return { startedAt: timestamps[0] ?? now.toISOString(), endedAt: now.toISOString(), timeZone };
}

function localDateParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day! };
}

function localDateTimeParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year!, month: values.month!, day: values.day!,
    hour: values.hour!, minute: values.minute!, second: values.second!,
  };
}

function localDaySerial(date: Date, timeZone: string): number {
  const value = localDateParts(date, timeZone);
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function zonedMidnightIso(year: number, month: number, day: number, timeZone: string): string {
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localDateTimeParts(new Date(instant), timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    instant += target - represented;
  }
  return new Date(instant).toISOString();
}

function addLocalDaysIso(date: Date, days: number, timeZone: string): string {
  const local = localDateParts(date, timeZone);
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return zonedMidnightIso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function calculateActivationSummaryV2(
  evidence: ActivationEvidence,
  now: Date,
  timeZone: string,
): ActivationSummaryV2 {
  const successfulRows = new Set(evidence.importRows.rows.filter((row) => row.status === "success").map((row) => row.batchId));
  const successfulImports = evidence.imports.rows.filter((batch) =>
    (batch.status === "completed" || batch.status === "partial_failure")
    && batch.completedAt !== null
    && successfulRows.has(batch.id));
  const terminal = evidence.imports.rows.filter((batch) => ["completed", "partial_failure", "failed", "undone"].includes(batch.status));
  const failedBatches = terminal.filter((batch) => batch.status === "partial_failure" || batch.status === "failed").length;
  const unknownBatches = evidence.imports.rows.filter((batch) => batch.status === "outcome_unknown").length;
  const determinedRows = evidence.importRows.rows.filter((row) => row.status === "success" || row.status === "rejected");
  const rejectedRows = determinedRows.filter((row) => row.status === "rejected").length;
  const unknownRows = evidence.importRows.rows.filter((row) => row.status === "outcome_unknown").length;

  const firstSuccessfulImport = [...successfulImports]
    .sort((left, right) => left.completedAt!.localeCompare(right.completedAt!))[0] ?? null;
  const fixedRun = firstSuccessfulImport
    ? [...evidence.runs.rows]
      .filter((run) => run.status === "completed"
        && run.workbookId === firstSuccessfulImport.workbookId
        && run.startedAt >= firstSuccessfulImport.completedAt!)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0] ?? null
    : null;
  const runFindings = fixedRun
    ? evidence.findings.rows.filter((finding) => finding.runHistory.includes(fixedRun.id))
    : [];
  const approvedAssignmentIds = new Set(evidence.assignmentEvents.rows
    .filter((event) => event.kind === "approved")
    .map((event) => event.assignmentId));
  const completedAssignments = evidence.assignments.rows.filter((assignment) =>
    assignment.status === "completed"
    && assignment.reviewedAt
    && approvedAssignmentIds.has(assignment.id));
  const approvedFindingIds = new Set(completedAssignments.flatMap((assignment) => assignment.findingIds));
  const reviewedClosed = runFindings.filter((finding) => finding.status === "closed" && approvedFindingIds.has(finding.id)).length;
  const notApplicable = runFindings.filter((finding) => finding.status === "not_applicable").length;
  const denominator = fixedRun?.findingCount ?? null;

  const findingById = new Map(evidence.findings.rows.map((finding) => [finding.id, finding]));
  const reviewDurations = completedAssignments.flatMap((assignment) => assignment.findingIds.flatMap((findingId) => {
    const finding = findingById.get(findingId);
    if (!finding || !assignment.reviewedAt) return [];
    const associatedImport = [...successfulImports]
      .filter((batch) => batch.workbookId === finding.workbookId && evidence.runs.rows.some((run) =>
        finding.runHistory.includes(run.id)
        && run.status === "completed"
        && batch.completedAt !== null
        && run.startedAt >= batch.completedAt))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0];
    if (!associatedImport || assignment.reviewedAt < associatedImport.startedAt) return [];
    return [Math.round((Date.parse(assignment.reviewedAt) - Date.parse(associatedImport.startedAt)) / 60_000)];
  }));
  const importedWorkbookIds = new Set(successfulImports.flatMap((batch) => batch.workbookId ?? []));
  const relevantRuns = evidence.runs.rows.filter((run) =>
    importedWorkbookIds.has(run.workbookId)
    && run.status === "completed"
    && successfulImports.some((batch) => batch.workbookId === run.workbookId && batch.completedAt !== null && run.startedAt >= batch.completedAt));
  const hasProblems = relevantRuns.some((run) => run.findingCount > 0);

  const actorsByAssignment = new Map<string, Set<string>>();
  for (const event of evidence.assignmentEvents.rows.filter((item) => item.kind === "submitted" || item.kind === "approved")) {
    const actors = actorsByAssignment.get(event.assignmentId) ?? new Set<string>();
    if (event.actorId) actors.add(event.actorId);
    actorsByAssignment.set(event.assignmentId, actors);
  }
  const humanActors = Math.max(0, ...completedAssignments
    .filter((assignment) => assignment.assigneeId !== assignment.reviewerId)
    .map((assignment) => actorsByAssignment.get(assignment.id)?.size ?? 0));

  const firstImportAt = firstSuccessfulImport?.completedAt ?? null;
  const windowStartedAt = firstImportAt ? addLocalDaysIso(new Date(firstImportAt), 7, timeZone) : null;
  const windowEndedAt = firstImportAt ? addLocalDaysIso(new Date(firstImportAt), 14, timeZone) : null;
  const nextWeekEvent = firstImportAt && evidence.activities.available
    ? evidence.activities.rows.filter((event) => {
      const day = localDaySerial(new Date(event.createdAt), timeZone) - localDaySerial(new Date(firstImportAt), timeZone);
      return day >= 7 && day <= 13;
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null
    : null;

  const progressUnknown = [evidence.users, evidence.workbooks, evidence.imports, evidence.runs, evidence.assignments].some((item) => !item.available);
  const activated = successfulImports.length > 0 && evidence.runs.rows.some((run) => run.status === "completed");
  const progressFailed = evidence.runs.available && evidence.runs.rows.some((run) => run.status === "failed");
  const reportPeriod = evidencePeriod(evidence, now, timeZone);
  const currentLocalDate = localDateParts(now, timeZone);
  return {
    contractVersion: "2",
    period: reportPeriod,
    stage: progressUnknown ? "unknown" : activated ? "activated" : progressFailed ? "failed" : "incomplete",
    progress: {
      members: { state: evidence.users.available ? (evidence.users.rows.length > 0 && evidence.users.rows.every((user) => user.lastSeenAt) ? "completed" : "incomplete") : "unknown", total: evidence.users.available ? evidence.users.rows.length : null, firstLoginCompleted: evidence.users.available ? evidence.users.rows.filter((user) => user.lastSeenAt).length : null, source: "user.last_seen_at", definition: "窗口：当前快照。活跃真人成员中已完成首次登录的人数 / 活跃真人成员总数" },
      workbooks: { state: evidence.workbooks.available ? (evidence.workbooks.rows.length ? "completed" : "incomplete") : "unknown", count: evidence.workbooks.available ? evidence.workbooks.rows.length : null, source: "workbook", definition: "窗口：当前快照。当前工作区持久工作簿数量" },
      imports: { state: evidence.imports.available && evidence.importRows.available ? (successfulImports.length ? "completed" : "incomplete") : "unknown", completed: evidence.imports.available ? successfulImports.length : null, outcomeUnknown: evidence.imports.available ? unknownBatches : null, source: "import_batch+import_batch_row", definition: "窗口：全部持久导入历史至摘要更新时间。至少有一行成功且确定终态的批次；待核实单列" },
      checks: { state: evidence.runs.available ? (evidence.runs.rows.some((run) => run.status === "completed") ? "completed" : evidence.runs.rows.some((run) => run.status === "failed") ? "failed" : "incomplete") : "unknown", completed: evidence.runs.available ? evidence.runs.rows.filter((run) => run.status === "completed").length : null, failed: evidence.runs.available ? evidence.runs.rows.filter((run) => run.status === "failed").length : null, source: "data_check_run", definition: "窗口：全部持久体检历史至摘要更新时间。完成数与失败数" },
      reviews: { state: evidence.assignments.available && evidence.assignmentEvents.available ? (completedAssignments.length ? "completed" : "incomplete") : "unknown", completed: evidence.assignments.available && evidence.assignmentEvents.available ? completedAssignments.length : null, pending: evidence.assignments.available ? evidence.assignments.rows.filter((item) => item.status === "submitted").length : null, source: "finding_assignment+finding_assignment_event", definition: "窗口：全部持久派单历史至摘要更新时间。真人 approved 的已完成复核；待审单列" },
    },
    outcomes: {
      firstReview: {
        state: !evidence.imports.available || !evidence.importRows.available || !evidence.runs.available || !evidence.assignments.available || !evidence.assignmentEvents.available || !evidence.findings.available
          ? "unknown" : successfulImports.length === 0 ? "incomplete" : !hasProblems && relevantRuns.length > 0 ? "not_applicable" : reviewDurations.length ? "completed" : "incomplete",
        durationMinutes: reviewDurations.length ? Math.min(...reviewDurations) : null,
        source: "import_batch.started_at→data_check_run→finding_assignment_event.approved",
        definition: "窗口：同工作簿首次确认导入 started_at 至关联体检问题首次真人 approved 复核。单位分钟",
      },
      importQuality: {
        state: !evidence.imports.available || !evidence.importRows.available ? "unknown" : terminal.length ? (failedBatches ? "failed" : "completed") : "incomplete",
        terminalBatches: evidence.imports.available ? terminal.length : null,
        failedBatches: evidence.imports.available ? failedBatches : null,
        outcomeUnknownBatches: evidence.imports.available ? unknownBatches : null,
        failureRate: evidence.imports.available ? rate(failedBatches, terminal.length) : null,
        determinedRows: evidence.importRows.available ? determinedRows.length : null,
        rejectedRows: evidence.importRows.available ? rejectedRows : null,
        outcomeUnknownRows: evidence.importRows.available ? unknownRows : null,
        rejectionRate: evidence.importRows.available ? rate(rejectedRows, determinedRows.length) : null,
        source: "import_batch.status+import_batch_row.status",
        definition: "窗口：全部持久导入历史至摘要更新时间。失败或部分失败批次 / 确定终态批次；拒绝行 / 结果已确定行",
      },
      issueResolution: {
        state: !evidence.runs.available || !evidence.findings.available || !evidence.assignments.available || !evidence.assignmentEvents.available ? "unknown" : !fixedRun ? "incomplete" : denominator === 0 ? "not_applicable" : reviewedClosed >= denominator! ? "completed" : "incomplete",
        runStartedAt: fixedRun?.startedAt ?? null,
        denominator,
        reviewedClosed: fixedRun ? reviewedClosed : null,
        notApplicable: fixedRun ? notApplicable : null,
        rate: denominator === null ? null : rate(reviewedClosed, denominator),
        source: "fixed data_check_run.finding_count",
        definition: "窗口：首次成功导入后首个完成体检运行（固定不随重扫更换）。真人 approved 且当前 closed 数 / 固定 finding_count",
      },
      collaboration: {
        state: !evidence.assignments.available || !evidence.assignmentEvents.available ? "unknown" : humanActors >= 2 ? "completed" : completedAssignments.length ? "incomplete" : "incomplete",
        humanActors: evidence.assignmentEvents.available ? humanActors : null,
        source: "finding_assignment_event.actor(kind=human)",
        definition: "窗口：全部持久派单历史至摘要更新时间。不同办理人与复核人的 submitted/approved 有效操作至少两位真人",
      },
      nextWeekUpdate: {
        state: !evidence.activities.available || !firstImportAt ? "unknown" : nextWeekEvent ? "completed" : "incomplete",
        windowStartedAt,
        windowEndedAt,
        evidenceAt: nextWeekEvent?.createdAt ?? null,
        source: "activity_event(record.write), local calendar day 7-13",
        definition: "窗口：首次成功导入完成后的本地自然日第 7 至 13 日。存在真实业务记录新增或修改",
      },
    },
    updatedAt: now.toISOString(),
    dedupeKey: `${currentLocalDate.year}-${String(currentLocalDate.month).padStart(2, "0")}:v2`,
  };
}

export async function buildActivationSummaryV2(
  conn: SurrealConn,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): Promise<ActivationSummaryV2> {
  return calculateActivationSummaryV2(await loadActivationEvidence(conn), now, timeZone);
}
