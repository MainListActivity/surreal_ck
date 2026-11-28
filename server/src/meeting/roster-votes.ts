import { createHash, randomUUID } from "node:crypto";
import { DateTime, isRetryableConflict, jsonify, RecordId, StringRecordId } from "surrealdb";
import { z } from "zod";
import { toIsoDateTimeString } from "../db/surreal-values";
import { HttpError } from "../http-error";
import { rosterRowsApi, type RosterQuery } from "./roster-gateway";

const pollTable = "roster_meeting_poll";
const headTable = "roster_meeting_ballot_head";
const ballotTable = "roster_meeting_ballot";
const MAX_POLLS = 50;

const choice = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/u);
const agendaItem = z.strictObject({
  title: z.string().trim().min(1).max(200),
  options: z.array(z.strictObject({ key: choice, label: z.string().trim().min(1).max(96) })).min(2).max(10)
    .refine((options) => new Set(options.map(({ key }) => key)).size === options.length),
  allowChange: z.boolean(),
});
export const voteAgendaSchema = z.array(agendaItem).max(MAX_POLLS);
export const openPollSchema = agendaItem.extend({ deadline: z.iso.datetime({ offset: true }) });
export const castVoteSchema = z.strictObject({
  option: choice,
  note: z.string().trim().max(500).transform((value) => value || undefined).optional(),
  requestId: z.uuid().optional(),
});
type OpenPoll = z.infer<typeof openPollSchema>;
type Vote = z.infer<typeof castVoteSchema>;
type Poll = {
  id: RecordId; meeting: RecordId; title: string; version: string; deadline: DateTime;
  options: OpenPoll["options"]; allow_change: boolean; weight_key?: string;
};
export type Ballot = {
  id: RecordId; poll: RecordId; subject: RecordId; name: string; choice: string; note?: string;
  at: DateTime; weight: unknown; revision: number;
};
type VotingMeeting = { id: RecordId; vote_weight_key?: string };
type Identity = { id: RecordId; roster_row: RecordId; lease_generation: number };

export function rows<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : [];
}

export function recordDigest(...values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function pollId(id: string): StringRecordId {
  if (!/^roster_meeting_poll:⟨[0-9a-f-]{36}⟩$/u.test(id)) throw notFound();
  return new StringRecordId(id);
}

function ballotHead(poll: RecordId, row: RecordId): RecordId {
  return new RecordId(headTable, recordDigest(String(poll), String(row)));
}

const notFound = () => new HttpError(404, "meeting-poll-not-found", "找不到此会议的表决或回执");
const closed = () => new HttpError(409, "meeting-poll-closed", "表决已截止或会议已结束");
const locked = () => new HttpError(409, "meeting-ballot-locked", "此表决不可更改，或提交编号已用于其他选择");
const badChoice = () => new HttpError(400, "meeting-ballot-option-invalid", "请选择此表决议题的有效选项");
const denied = () => new HttpError(401, "meeting-roster-denied", "无法验证参会凭证");

async function requirePoll(db: RosterQuery, meeting: VotingMeeting, id: string): Promise<Poll> {
  const [poll] = rows<Poll>(await db.query("SELECT * FROM $id WHERE meeting = $meeting;", { id: pollId(id), meeting: meeting.id }));
  if (!poll) throw notFound();
  return poll;
}

function publicPoll(poll: Poll) {
  return { id: String(poll.id), title: poll.title, version: poll.version, deadline: toIsoDateTimeString(poll.deadline),
    options: poll.options, allowChange: poll.allow_change };
}

function publicBallot(ballot: Ballot) {
  return { option: ballot.choice, note: ballot.note, at: toIsoDateTimeString(ballot.at) };
}

async function latestBallot(db: RosterQuery, poll: RecordId, subject: RecordId): Promise<Ballot | undefined> {
  return rows<Ballot>(await db.query("SELECT * FROM (SELECT VALUE ballot FROM $head);", {
    head: ballotHead(poll, subject),
  }))[0];
}

export async function pollsForMeeting(db: RosterQuery, meeting: VotingMeeting) {
  return rows<Poll>(await db.query(
    "SELECT * FROM roster_meeting_poll WHERE meeting = $meeting ORDER BY created_at, id;", { meeting: meeting.id },
  ));
}

export async function publishPoll(db: RosterQuery, meeting: VotingMeeting, input: OpenPoll) {
  const id = new RecordId(pollTable, randomUUID());
  const deadline = new DateTime(new Date(input.deadline));
  const version = recordDigest(String(id), input.title, deadline.toString(), JSON.stringify(input.options), String(input.allowChange), meeting.vote_weight_key ?? "");
  try {
    await db.query(`
      BEGIN TRANSACTION;
      IF !(SELECT VALUE id FROM $meeting WHERE status = "open"
        AND ($deadline <= ends_at OR ends_at = NONE))[0] OR $deadline <= time::now() { THROW "poll-closed"; };
      IF array::len(SELECT VALUE id FROM roster_meeting_poll WHERE meeting = $meeting LIMIT $max) >= $max {
        THROW "poll-limit";
      };
      CREATE $id SET meeting = $meeting, title = $title, deadline = $deadline, options = $options,
        allow_change = $allow, weight_key = $weightKey, version = $version;
      COMMIT TRANSACTION;
    `, { id, meeting: meeting.id, deadline, version, title: input.title, options: input.options,
      allow: input.allowChange, weightKey: meeting.vote_weight_key, max: MAX_POLLS });
  } catch (error) {
    if (error instanceof Error && error.message.includes("poll-closed")) throw closed();
    if (error instanceof Error && error.message.includes("poll-limit")) {
      throw new HttpError(409, "meeting-poll-limit", "此会议的表决议题已达到上限");
    }
    throw error;
  }
  return publicPoll(await requirePoll(db, meeting, String(id)));
}

export async function participantPolls(db: RosterQuery, meeting: VotingMeeting, subject: RecordId) {
  const polls = await pollsForMeeting(db, meeting);
  if (!polls.length) return [];
  const ballots = rows<Ballot>(await db.query("SELECT * FROM (SELECT VALUE ballot FROM $heads);", {
    heads: polls.map(({ id }) => ballotHead(id, subject)),
  }));
  const byPoll = new Map(ballots.map((ballot) => [String(ballot.poll), ballot]));
  return polls.map((poll) => {
    const ballot = byPoll.get(String(poll.id));
    return { ...publicPoll(poll), ballot: ballot && publicBallot(ballot) };
  });
}

export async function castVote(db: RosterQuery, meeting: VotingMeeting, pass: Identity, name: string, id: string, input: Vote,
  onSaved?: (ballot: Ballot, version: string) => Promise<void>) {
  const poll = await requirePoll(db, meeting, id);
  if (!poll.options.some((option) => option.key === input.option)) throw badChoice();
  const subject = pass.roster_row;
  const head = ballotHead(poll.id, subject);
  const ballot = new RecordId(ballotTable, recordDigest(String(head), input.requestId ?? randomUUID()));
  for (let attempt = 0; ; attempt++) {
    try {
      await db.query(`
        BEGIN TRANSACTION;
        LET $now = time::now();
        IF !(SELECT VALUE id FROM $meeting WHERE status = "open" AND (ends_at = NONE OR ends_at > $now))[0]
          OR $deadline <= $now { THROW "poll-closed"; };
        IF !(SELECT VALUE id FROM $pass WHERE meeting = $meeting AND roster_row = $subject
          AND status = "active" AND lease_state = "admitted" AND lease_generation = $generation
          AND lease_expires_at > $now AND expires_at > $now)[0] { THROW "poll-identity-denied"; };
        LET $roster = api::invoke('${rosterRowsApi}', { method: 'post', body: { meeting: $meeting, ids: [$subject], poll: $poll } });
        IF $roster.status != 200 OR array::len($roster.body) != 1 { THROW "poll-identity-denied"; };
        LET $old = (SELECT VALUE ballot FROM $head)[0];
        LET $current = (SELECT * FROM $old)[0];
        LET $retry = (SELECT * FROM $ballot)[0];
        IF $retry != NONE {
          IF $retry.choice != $choice OR $retry.note != $note { THROW "poll-ballot-locked"; };
        } ELSE IF $current = NONE OR $current.choice != $choice OR $current.note != $note OR ($request AND $allow) {
          IF $current != NONE AND !$allow { THROW "poll-ballot-locked"; };
          LET $weight = IF $current != NONE { $current.weight } ELSE IF $weightKey = NONE { 1dec } ELSE {
            LET $rawWeight = $roster.body[0].weight;
            IF type::is_number($rawWeight) AND $rawWeight >= 0 { <decimal>$rawWeight } ELSE { 0dec }
          };
          CREATE $ballot SET meeting = $meeting, poll = $poll, subject = $subject, name = $name,
            choice = $choice, note = $note, weight = $weight, revision = ($current.revision ?? 0) + 1, at = $now;
          UPSERT $head SET meeting = $meeting, poll = $poll, ballot = $ballot;
        };
        COMMIT TRANSACTION;
      `, { meeting: meeting.id, pass: pass.id, generation: pass.lease_generation, poll: poll.id, deadline: poll.deadline,
        subject, name, head, ballot, choice: input.option, note: input.note, allow: poll.allow_change,
        weightKey: poll.weight_key, request: Boolean(input.requestId) });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("poll-closed")) throw closed();
      if (message.includes("poll-ballot-locked")) throw locked();
      if (message.includes("poll-identity-denied")) throw denied();
      if (isRetryableConflict(error) || /transaction conflict|transaction has been cancelled/iu.test(message)) {
        if (attempt < 3) continue;
        throw new HttpError(409, "meeting-ballot-conflict", "表决状态已改变，请刷新后重试");
      }
      throw error;
    }
  }
  const [saved] = rows<Ballot>(await db.query("SELECT * FROM $ballot;", { ballot }));
  const result = saved ?? await latestBallot(db, poll.id, subject);
  if (!result) throw notFound();
  await onSaved?.(result, poll.version);
  return publicBallot(result);
}

export async function receipt(db: RosterQuery, meeting: VotingMeeting, subject: RecordId, id: string) {
  const poll = await requirePoll(db, meeting, id);
  const ballot = await latestBallot(db, poll.id, subject);
  const label = ballot && poll.options.find(({ key }) => key === ballot.choice)?.label;
  if (!ballot || !label) throw notFound();
  return { title: poll.title, version: poll.version, deadline: toIsoDateTimeString(poll.deadline), name: ballot.name,
    ...publicBallot(ballot), label, revision: ballot.revision };
}

export async function voteResults(db: RosterQuery, meeting: VotingMeeting) {
  const polls = await pollsForMeeting(db, meeting);
  const totals = rows<{ poll: RecordId; choice: string; count: number; weight: unknown }>(await db.query(`
    SELECT poll, ballot.choice AS choice, count() AS count, math::sum(ballot.weight) AS weight
    FROM roster_meeting_ballot_head WHERE meeting = $meeting GROUP BY poll, choice;
  `, { meeting: meeting.id }));
  const byOption = new Map(totals.map((row) => [JSON.stringify([String(row.poll), row.choice]), row]));
  return polls.map((poll) => ({ ...publicPoll(poll), results: poll.options.map((option) => {
    const row = byOption.get(JSON.stringify([String(poll.id), option.key]));
    return { ...option, count: row?.count ?? 0, weight: Number(jsonify(row?.weight ?? 0)) };
  }) }));
}
