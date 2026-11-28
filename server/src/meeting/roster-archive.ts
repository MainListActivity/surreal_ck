import { DateTime, isRetryableConflict, jsonify, RecordId } from "surrealdb";
import { z } from "zod";
import { extractNativeQuotaError, type NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import { dateTimeTimestamp, toIsoDateTimeString } from "../db/surreal-values";
import { HttpError } from "../http-error";
import { callRosterGateway, rosterArchiveApi, type RosterQuery } from "./roster-gateway";
import { recordDigest, rows, voteResults, type Ballot } from "./roster-votes";

export const archiveConfigSchema = z.strictObject({
  attendanceSheet: z.string().min(7).max(512),
  voteSheet: z.string().min(7).max(512),
  weightField: z.string().trim().min(1).max(128).optional(),
});

const attendanceFields = { meeting_id: "text", subject_id: "text", name: "text", attended: "checkbox",
  duration_ms: "number", segments: "text", timeline: "text" };
const voteFields = { meeting_id: "text", poll_id: "text", title: "text", version: "text", option: "text",
  label: "text", count: "number", weight: "number", ballots: "text" };

export type ArchiveSheet = { id: RecordId; workbook: RecordId; table_name: string; column_defs: unknown };
export type ExpectedSubject = { subject: string; name: string };
type ArchiveMeeting = { id: RecordId; roster_snapshot?: ExpectedSubject[]; vote_weight_key?: string };
export type TimelineEvent = {
  id: RecordId; subject: RecordId; pass: RecordId; kind: string; at: DateTime; connection?: string; actor?: string; name?: string;
};

const configError = () => new HttpError(400, "meeting-archive-config-invalid",
  "请选择同一工作簿内符合字段要求的独立签到表和表决表，权重须绑定名册的数值列");
const quotaError = () => new HttpError(409, "meeting-archive-quota", "会议归档记录配额不足，签到与表决均未写入");
const archiveConflict = () => new HttpError(409, "meeting-archive-conflict", "归档工作表已改变，请刷新后重试");
const archiveUnavailable = () => new HttpError(503, "meeting-archive-unavailable", "会议归档暂不可写入");

function columns(sheet: ArchiveSheet): Map<string, string> {
  const parsed = z.array(z.object({ key: z.string(), field_type: z.string().optional() })).safeParse(sheet.column_defs);
  return new Map(parsed.success ? parsed.data.map((column) => [column.key, column.field_type ?? "text"]) : []);
}

export function verifyArchiveSheets(roster: ArchiveSheet, attendance: ArchiveSheet, vote: ArchiveSheet, weightField?: string) {
  const targets = [attendance, vote];
  if (new Set([roster.table_name, attendance.table_name, vote.table_name]).size !== 3
    || targets.some((sheet) => String(sheet.workbook) !== String(roster.workbook) || !sheet.table_name.startsWith("ent_"))
    || (weightField && !["number", "decimal"].includes(columns(roster).get(weightField) ?? ""))) throw configError();
  for (const [target, required] of [[attendance, attendanceFields], [vote, voteFields]] as const) {
    const fields = columns(target);
    if (Object.entries(required).some(([key, fieldType]) => fields.get(key) !== fieldType)) throw configError();
  }
}

function attendanceRow(subject: ExpectedSubject, events: TimelineEvent[], cutoff: number) {
  const connections = new Map<string, { joined?: number; left?: number; pass: string }>();
  const detachments = new Map<string, number[]>();
  let name = subject.name;
  const timeline = events.flatMap((event) => {
    const at = dateTimeTimestamp(event.at);
    if (!at || at > cutoff) return [];
    const pass = String(event.pass);
    if (event.name) name = event.name;
    if (event.connection) {
      const connection = connections.get(event.connection) ?? { pass };
      if (event.kind === "joined") connection.joined ??= at;
      if (event.kind === "left") connection.left ??= at;
      connections.set(event.connection, connection);
    }
    if (["kicked", "replaced", "revoked", "rejected"].includes(event.kind)) {
      const times = detachments.get(pass) ?? [];
      times.push(at);
      detachments.set(pass, times);
    }
    return [{ kind: event.kind, at: new Date(at).toISOString(), actor: event.actor, connection: event.connection }];
  });
  const intervals = [...connections.entries()].flatMap(([id, { joined, left, pass }]) => {
    if (joined === undefined) return [];
    const forced = detachments.get(pass)?.find((at) => at >= joined);
    const confirmed = Math.min(left ?? Infinity, forced ?? Infinity);
    return [{ id, joined, left: Math.max(joined, Math.min(confirmed, cutoff)), estimated: confirmed === Infinity }];
  }).sort((left, right) => left.joined - right.joined);
  let duration = 0;
  let last = 0;
  for (const { joined, left } of intervals) {
    duration += Math.max(0, left - Math.max(last, joined));
    last = Math.max(last, left);
  }
  return { subject_id: subject.subject, name, attended: intervals.length > 0,
    duration_ms: duration, timeline: JSON.stringify(timeline),
    segments: JSON.stringify(intervals.map(({ id, joined, left, estimated }) => ({
      id, joined: new Date(joined).toISOString(), left: new Date(left).toISOString(), estimated,
    }))) };
}

function exportBallot(ballot: Ballot) {
  return { name: ballot.name, option: ballot.choice, at: toIsoDateTimeString(ballot.at), note: ballot.note,
    revision: ballot.revision, weight: jsonify(ballot.weight) };
}

export async function archiveMeeting(db: RosterQuery, meeting: ArchiveMeeting, targets: {
  attendance: ArchiveSheet; vote: ArchiveSheet;
}, subjects: ExpectedSubject[], cutoff: number, quota: NativeQuotaInfo) {
  const meetingId = String(meeting.id);
  const events = rows<TimelineEvent>(await db.query(
    "SELECT * FROM roster_meeting_event WHERE meeting = $meeting AND at <= $cutoff ORDER BY at, id;",
    { meeting: meeting.id, cutoff: new DateTime(new Date(cutoff)) },
  ));
  const history = new Map<string, TimelineEvent[]>();
  const expected = new Map(subjects.map((subject) => [subject.subject, subject]));
  for (const event of events) {
    const subject = String(event.subject);
    if (!expected.has(subject)) expected.set(subject, { subject, name: event.name ?? "" });
    const entries = history.get(subject) ?? [];
    entries.push(event);
    history.set(subject, entries);
  }
  const attendance = [...expected.values()].map((subject) => ({
    id: new RecordId(targets.attendance.table_name, "meeting_" + recordDigest(meetingId, subject.subject)),
    values: attendanceRow(subject, history.get(subject.subject) ?? [], cutoff),
  }));
  const ballots = rows<Ballot>(await db.query(
    "SELECT * FROM roster_meeting_ballot WHERE meeting = $meeting ORDER BY revision, id;", { meeting: meeting.id },
  ));
  const ballotsByPoll = new Map<string, Map<string, Ballot[]>>();
  for (const ballot of ballots) {
    const poll = String(ballot.poll);
    const subject = String(ballot.subject);
    const groups = ballotsByPoll.get(poll) ?? new Map<string, Ballot[]>();
    const revisions = groups.get(subject) ?? [];
    revisions.push(ballot);
    groups.set(subject, revisions);
    ballotsByPoll.set(poll, groups);
  }
  const votes = (await voteResults(db, meeting)).flatMap((poll) => poll.results.map((result) => ({
    id: new RecordId(targets.vote.table_name, "meeting_" + recordDigest(meetingId, poll.id, result.key)),
    values: { poll_id: poll.id, title: poll.title, version: poll.version,
      option: result.key, label: result.label, count: result.count, weight: result.weight,
      ballots: JSON.stringify([...(ballotsByPoll.get(poll.id) ?? [])].flatMap(([subject, revisions]) =>
        revisions.at(-1)?.choice === result.key ? [{ subject, revisions: revisions.map(exportBallot) }] : [])) },
  })));

  const binding = {
    meeting: meeting.id,
    attendance: { id: targets.attendance.id, table: targets.attendance.table_name },
    vote: { id: targets.vote.id, table: targets.vote.table_name },
  };
  if (quota.policy) {
    if (!quota.ledger.usage_trusted || !quota.usage) {
      throw new HttpError(503, "meeting-archive-quota-unavailable", "暂时无法核实记录配额，未写入会议归档");
    }
    for (const [target, entries] of [[targets.attendance, attendance], [targets.vote, votes]] as const) {
      if (!entries.length) continue;
      const usage = quota.usage.tables.find((row) => row.table === target.table_name)?.record;
      if (!usage) throw new HttpError(503, "meeting-archive-quota-unavailable", "暂时无法核实目标表配额，未写入会议归档");
      if (usage.limit.kind === "unlimited") continue;
      const existing = await callRosterGateway<RecordId[]>(db, "archive", {
        ...binding, mode: "existing", entries: entries.map(({ id }) => ({ id })),
      });
      if (existing.status === 409) throw archiveConflict();
      if (existing.status !== 200) throw archiveUnavailable();
      if (usage.remaining == null) throw new HttpError(503, "meeting-archive-quota-unavailable", "暂时无法核实目标表配额，未写入会议归档");
      if (BigInt(usage.remaining) < BigInt(entries.length - existing.body.length)) throw quotaError();
    }
  }

  try {
    await db.query(`
      BEGIN TRANSACTION;
      LET $archive = api::invoke('${rosterArchiveApi}', { method: 'post', body: $body });
      IF $archive.status = 409 { THROW "archive-binding-changed"; };
      IF $archive.status != 200 { THROW "archive-write-failed"; };
      COMMIT TRANSACTION;
    `, { body: { ...binding, mode: "write", entries: [...attendance, ...votes], subjects } });
  } catch (error) {
    if (extractNativeQuotaError(error)?.code === "quota_exceeded" || (error instanceof Error && error.message.includes("quota-records-exceeded"))) {
      throw quotaError();
    }
    if (isRetryableConflict(error) || (error instanceof Error && error.message.includes("archive-binding-changed"))) {
      throw archiveConflict();
    }
    if (error instanceof Error && error.message.includes("archive-write-failed")) throw archiveUnavailable();
    throw error;
  }
  return { attendanceSheet: String(targets.attendance.id), voteSheet: String(targets.vote.id) };
}
