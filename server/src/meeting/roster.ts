import { randomInt } from "node:crypto";
import { DateTime, isRetryableConflict, RecordId, StringRecordId } from "surrealdb";
import type { RosterMeetingCommand } from "@surreal-ck/shared";
import { extractNativeQuotaError } from "@surreal-ck/shared/native-quota";
import { isSafeSheetTableName } from "@surreal-ck/shared/resource-quota";
import { z } from "zod";
import { resolveWorkspaceBySlug } from "../../ai/office/employee-service";
import { SurrealNativeQuotaClient } from "../db/native-quota/client";
import { getRootDatabaseSession } from "../db/root-connection";
import { dateTimeTimestamp, toIsoDateTimeString } from "../db/surreal-values";
import { env } from "../env";
import { HttpError } from "../http-error";
import { generateToken, hashToken, safeTextEqual, signPayload, verifySignature } from "../secure-token";
import { rosterRoomLocked, type PrivateMeetingSfu, type SfuActor } from "./sfu";

const PASS_TABLE = "roster_meeting_pass";
const MEETING_TABLE = "roster_meeting";
const WINDOW = 15 * 60_000;
const LOCK = 30 * 60_000;
const SESSION_TTL = 2 * 60 * 60_000;
const PASS_TTL = 7 * 24 * 60 * 60_000;
const MAX_BUCKETS = 20_000;
export const MAX_ROSTER_BATCH = 500;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const passPattern = /^([a-z0-9][a-z0-9-]{0,62})\.[A-Za-z0-9_-]{43}$/u;
const admissionSchema = z.enum(["direct", "waiting"]);
const concurrencySchema = z.enum(["replace", "reject"]);
const checkModeSchema = z.enum(["full", "suffix4"]);
const presetSchema = z.object({
  key: z.string(), sheet_key: z.string(), display_key: z.string(),
  check_key: z.string().optional(), check_label: z.string().optional(), check_mode: checkModeSchema.optional(),
  admission: admissionSchema, concurrency: concurrencySchema,
});
const cookieSchema = z.strictObject({
  slug: z.string().regex(slugPattern), meeting: z.string(), pass: z.string(),
  generation: z.number().int().positive(), session: z.string(), exp: z.number().int().positive(),
});

type Cookie = z.infer<typeof cookieSchema>;
type Admission = z.infer<typeof admissionSchema>;
type LeaseState = "waiting" | "admitted" | "kicked";
type Query = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
type Media = Pick<PrivateMeetingSfu, "maxSeats" | "startRoster" | "endRoster" | "hasRosterRoom" | "rosterCredentials" | "dropRoster"
  | "isRosterLocked" | "rosterFocus" | "raiseRosterHand" | "rosterModeration" | "moderateRoster" | "assertRosterHost">;
type Deps = {
  getSession?: (db: string) => Promise<Query>;
  resolveWorkspace?: typeof resolveWorkspaceBySlug;
  remaining?: (db: Query, database: string) => Promise<bigint | null>;
  getPepper?: () => string | undefined;
  media?: Media;
  now?: () => number;
};
type Meeting = {
  id: RecordId; title: string; roster_sheet: RecordId; display_field: string; check_field?: string;
  check_mode?: z.infer<typeof checkModeSchema>; check_label?: string; admission: Admission;
  concurrency: z.infer<typeof concurrencySchema>; status: "open" | "closed"; scheduled_at: unknown; ends_at?: unknown; room_id?: string;
};
type Pass = {
  id: RecordId; meeting: RecordId; roster_row: RecordId; status: "active" | "revoked"; code_hash: string;
  expires_at: unknown; opened_at?: unknown; failure_count: number; failure_window_at?: unknown; locked_until?: unknown;
  lease_generation: number; lease_session?: string; lease_expires_at?: unknown; lease_verified_at?: unknown; lease_state?: LeaseState;
};
type Sheet = { id: RecordId; workbook: RecordId; table_name: string; column_defs: unknown; template_sheet_key?: string };
type Actor = SfuActor;
type Create = {
  title: string; scheduled_at: string; ends_at?: string; sheet_id: string; display_field?: string;
  check_field?: string; check_mode?: z.infer<typeof checkModeSchema>; check_label?: string;
  admission?: Admission; concurrency?: Meeting["concurrency"]; preset_key?: string;
};

export const rosterDenied = () => new HttpError(401, "meeting-roster-denied", "无法验证参会凭证");
const rateLimited = () => new HttpError(429, "meeting-roster-rate-limit", "请求过于频繁，请稍后重试");
const missing = () => new HttpError(404, "meeting-roster-not-found", "没有找到会议或名册记录");
const invalid = () => new HttpError(400, "meeting-roster-invalid", "名册会议参数无效");
const unavailable = () => new HttpError(503, "meeting-roster-unavailable", "名册会议服务尚未启用");
const conflict = () => new HttpError(409, "meeting-roster-conflict", "会议状态已改变，请刷新后重试");
const quotaError = () => new HttpError(409, "meeting-roster-quota", "参会凭证记录配额不足，未更改任何凭证");
const noRoom = () => new HttpError(409, "meeting-roster-room-unavailable", "大会尚未开始或媒体服务需要重新开启");

function writeError(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : "";
  if (extractNativeQuotaError(cause)?.code === "quota_exceeded") throw quotaError();
  if (message.includes("roster-row-missing")) throw missing();
  if (isRetryableConflict(cause) || /roster-pass-conflict|roster_meeting_pass_(one_active|hash_unique)|transaction conflict/iu.test(message)) {
    throw conflict();
  }
  throw cause;
}

function statement<T>(result: unknown, index = 0): T[] {
  if (!Array.isArray(result) || !Array.isArray(result[index])) return [];
  return result[index] as T[];
}

function record(table: string, value: string): StringRecordId {
  if (!value.startsWith(`${table}:`) || value.length <= table.length + 1 || value.length > 512) throw invalid();
  return new StringRecordId(value);
}

function rosterSubject(id: RecordId | StringRecordId): string {
  return `roster:${id}`;
}

function fieldText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function codeDigest(code: string, pepper: string, salt = generateToken(16)): string {
  return `${salt}.${signPayload(`access-code:${salt}:${code}`, pepper)}`;
}

function meetingView(row: Meeting) {
  return {
    id: String(row.id), title: row.title, scheduled_at: toIsoDateTimeString(row.scheduled_at),
    ends_at: toIsoDateTimeString(row.ends_at), sheet_id: String(row.roster_sheet), display_field: row.display_field,
    check_field: row.check_field, check_mode: row.check_mode, check_label: row.check_label,
    admission: row.admission, concurrency: row.concurrency, status: row.status, room_id: row.room_id,
  };
}

function passView(row: Pass) {
  return {
    id: String(row.id), row_id: String(row.roster_row), status: row.status,
    opened_at: toIsoDateTimeString(row.opened_at), expires_at: toIsoDateTimeString(row.expires_at),
    lease_state: row.lease_state, generation: row.lease_generation,
  };
}

type Bucket = { count: number; until: number; lockedUntil?: number };
class VerifyLimits {
  private readonly sources = new Map<string, Bucket>();
  private readonly passes = new Map<string, Bucket>();
  private nextCleanup = 0;

  private bucket(map: Map<string, Bucket>, key: string, now: number): Bucket {
    const previous = map.get(key);
    if (previous && Math.max(previous.until, previous.lockedUntil ?? 0) > now) return previous;
    if (!previous && map.size >= MAX_BUCKETS) throw rateLimited();
    const current = { count: 0, until: now + WINDOW };
    map.set(key, current);
    return current;
  }

  start(source: string, hash: string, now: number): void {
    if (now >= this.nextCleanup) {
      this.nextCleanup = now + 60_000;
      for (const map of [this.sources, this.passes]) {
        for (const [key, value] of map) {
          if (Math.max(value.until, value.lockedUntil ?? 0) <= now) map.delete(key);
        }
      }
    }
    if (++this.bucket(this.sources, source, now).count > 30) throw rateLimited();
    this.check(hash, now);
  }

  check(hash: string, now: number): void {
    if ((this.bucket(this.passes, hash, now).lockedUntil ?? 0) > now) throw rateLimited();
  }

  fail(hash: string, now: number): void {
    this.check(hash, now);
    const bucket = this.bucket(this.passes, hash, now);
    if (++bucket.count >= 5) bucket.lockedUntil = now + LOCK;
  }

  success(hash: string): void { this.passes.delete(hash); }
}

export class RosterMeetingService {
  private readonly getSession: NonNullable<Deps["getSession"]>;
  private readonly resolveWorkspace: typeof resolveWorkspaceBySlug;
  private readonly getPepper: NonNullable<Deps["getPepper"]>;
  private readonly remaining: NonNullable<Deps["remaining"]>;
  private readonly media?: Media;
  private readonly now: () => number;
  private readonly limits = new VerifyLimits();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(deps: Deps = {}) {
    this.getSession = deps.getSession ?? getRootDatabaseSession;
    this.resolveWorkspace = deps.resolveWorkspace ?? resolveWorkspaceBySlug;
    this.getPepper = deps.getPepper ?? (() => env.MEETING_ROSTER_PEPPER);
    this.media = deps.media;
    this.now = deps.now ?? Date.now;
    this.remaining = deps.remaining ?? (async (db, database) => {
      const quota = await new SurrealNativeQuotaClient(db).info(database);
      const remaining = quota.usage?.tables.find((row) => row.table === PASS_TABLE)?.record.remaining;
      return quota.ledger.usage_trusted && remaining != null ? BigInt(remaining) : null;
    });
  }

  assertEnabled(): string {
    const pepper = this.getPepper();
    if (!pepper || pepper.length < 32) throw unavailable();
    return pepper;
  }

  private withWorkspace<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(key, result);
    const cleanup = () => { if (this.queues.get(key) === result) this.queues.delete(key); };
    void result.then(cleanup, cleanup);
    return result;
  }

  async workspaceDb(slug: string): Promise<string> {
    const row = slugPattern.test(slug) && await this.resolveWorkspace(slug);
    if (!row) throw new HttpError(404, "workspace-not-found", "找不到可用的工作区");
    return row.dbName;
  }

  private async meeting(db: Query, id: string | RecordId): Promise<Meeting | undefined> {
    return statement<Meeting>(await db.query("SELECT * FROM $id;", {
      id: typeof id === "string" ? record(MEETING_TABLE, id) : id,
    }))[0];
  }

  private async requireMeeting(db: Query, id: string): Promise<Meeting> {
    const meeting = await this.meeting(db, id);
    if (!meeting) throw missing();
    return meeting;
  }

  private open(meeting: Meeting, now = this.now()): boolean {
    return meeting.status === "open" && (!meeting.ends_at || dateTimeTimestamp(meeting.ends_at) > now);
  }

  private async sheet(db: Query, id: RecordId | StringRecordId): Promise<Sheet> {
    const sheet = statement<Sheet>(await db.query(
      "SELECT id, workbook, table_name, column_defs, template_sheet_key FROM $id WHERE workbook != NONE AND workbook.id != NONE;", { id },
    ))[0];
    if (!sheet || !isSafeSheetTableName(sheet.table_name)) throw missing();
    return sheet;
  }

  async create(database: string, subject: string, input: Create) {
    this.assertEnabled();
    const db = await this.getSession(database);
    const sheet = await this.sheet(db, record("sheet", input.sheet_id));
    const preset = input.preset_key && await this.preset(db, sheet, input.preset_key);
    const display = input.display_field ?? (preset || undefined)?.display_key;
    const check = input.check_field ?? (preset || undefined)?.check_key;
    const checkMode = input.check_mode ?? (preset || undefined)?.check_mode;
    const checkLabel = input.check_label ?? (preset || undefined)?.check_label;
    const admission = input.admission ?? (preset || undefined)?.admission;
    const concurrency = input.concurrency ?? (preset || undefined)?.concurrency ?? "replace";
    const keys = new Set(Array.isArray(sheet.column_defs)
      ? sheet.column_defs.flatMap((column: unknown) => (typeof column === "object" && column !== null && "key" in column ? [column.key] : []))
      : []);
    const scheduled = Date.parse(input.scheduled_at);
    const ends = input.ends_at === undefined ? undefined : Date.parse(input.ends_at);
    if (!display || !keys.has(display) || (check && !keys.has(check)) || (!check && (checkMode || checkLabel))
      || !admission || !Number.isFinite(scheduled) || (ends !== undefined && (!Number.isFinite(ends) || ends <= scheduled))) throw invalid();
    const [created] = statement<Meeting>(await db.query(`
      CREATE roster_meeting SET title = $title, roster_sheet = $sheet, scheduled_at = $scheduled, ends_at = $ends,
        display_field = $display, check_field = $check, check_mode = $checkMode, check_label = $checkLabel,
        admission = $admission, concurrency = $concurrency, created_by = $subject;
    `, {
      title: input.title, sheet: sheet.id, scheduled: new DateTime(new Date(scheduled)),
      ends: ends === undefined ? undefined : new DateTime(new Date(ends)),
      display, check, checkMode, checkLabel, admission, concurrency, subject,
    }));
    if (!created) throw conflict();
    return meetingView(created);
  }

  private async preset(db: Query, sheet: Sheet, key: string) {
    const [row] = statement<{ presets?: unknown }>(await db.query(
      "SELECT template.roster_meeting_presets AS presets FROM $workbook;", { workbook: sheet.workbook },
    ));
    const parsed = z.array(presetSchema).safeParse(row?.presets);
    const preset = parsed.success && parsed.data.find((item) => item.key === key && item.sheet_key === sheet.template_sheet_key);
    if (!preset) throw missing();
    return preset;
  }

  async list(database: string) {
    this.assertEnabled();
    const db = await this.getSession(database);
    return statement<Meeting>(await db.query("SELECT * FROM roster_meeting ORDER BY scheduled_at DESC;")).map(meetingView);
  }

  async passes(database: string, meetingId: string) {
    this.assertEnabled();
    const db = await this.getSession(database);
    const meeting = await this.requireMeeting(db, meetingId);
    return statement<Pass>(await db.query(`
      SELECT id, roster_row, status, opened_at, expires_at, lease_state, lease_generation
        FROM roster_meeting_pass WHERE meeting = $meeting ORDER BY id;
    `, { meeting: meeting.id })).map(passView);
  }

  async issue(database: string, slug: string, meetingId: string, rows: string[], actor: string, replace = false) {
    const pepper = this.assertEnabled();
    if (!rows.length || rows.length > MAX_ROSTER_BATCH || (replace && rows.length !== 1)) throw invalid();
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const meeting = await this.requireMeeting(db, meetingId);
      if (!this.open(meeting)) throw conflict();
      const sheet = await this.sheet(db, meeting.roster_sheet);
      const ids = rows.map((row) => record(sheet.table_name, row));
      if (new Set(ids.map(String)).size !== rows.length) throw invalid();
      const remaining = await this.remaining(db, database);
      if (remaining !== null && remaining < BigInt(rows.length)) throw quotaError();
      const roster = statement<Record<string, unknown>>(await db.query("SELECT * FROM $ids;", { ids }));
      if (roster.length !== ids.length) throw missing();
      const entries = roster.map((row) => {
        const name = fieldText(row[meeting.display_field]);
        if (!name || (meeting.check_field && !this.checkValue(meeting, row))) throw invalid();
        const pass = `${slug}.${generateToken()}`;
        const code = String(randomInt(100_000, 1_000_000));
        return { row: row.id, id: new RecordId(PASS_TABLE, crypto.randomUUID()), name, pass, code,
          passHash: hashToken(pass, pepper), codeHash: codeDigest(code, pepper) };
      });
      const old = replace ? statement<{ id: RecordId }>(await db.query(`
        SELECT id FROM roster_meeting_pass WHERE meeting = $meeting AND roster_row INSIDE $ids AND status = "active";
      `, { meeting: meeting.id, ids })) : [];
      const expires = Math.min(this.now() + PASS_TTL, dateTimeTimestamp(meeting.ends_at) || Infinity);
      try {
        await db.query(`
          BEGIN TRANSACTION;
          IF !(SELECT VALUE id FROM $meeting WHERE status = "open" AND (ends_at = NONE OR ends_at > time::now()))[0] {
            THROW "roster-pass-conflict";
          };
          FOR $entry IN $entries {
            IF !(SELECT VALUE id FROM $entry.row LIMIT 1)[0] { THROW "roster-row-missing"; };
            IF $replace {
              LET $retired = UPDATE roster_meeting_pass SET status = "revoked", lease_generation += 1
                WHERE meeting = $meeting AND roster_row = $entry.row AND status = "active" RETURN id;
              FOR $item IN $retired {
                CREATE roster_meeting_audit SET action = "revoked", target = $item.id, actor = $actor;
              };
            };
            CREATE $entry.id SET meeting = $meeting, roster_row = $entry.row,
              pass_hash = $entry.passHash, code_hash = $entry.codeHash, expires_at = $expires;
            CREATE roster_meeting_audit SET action = "issued", target = $entry.id, actor = $actor;
          };
          COMMIT TRANSACTION;
        `, {
          entries: entries.map(({ row, id, passHash, codeHash }) => ({ row, id, passHash, codeHash })),
          meeting: meeting.id, expires: new DateTime(new Date(expires)), replace, actor,
        });
      } catch (cause) { writeError(cause); }
      if (meeting.room_id && this.media) {
        for (const row of old) await this.media.dropRoster(database, meeting.room_id, rosterSubject(row.id));
      }
      return entries.map(({ name, pass, code }) => ({
        name, pass, code, checkLabel: meeting.check_field ? meeting.check_label || "名册校对" : undefined,
      }));
    });
  }

  private checkValue(meeting: Meeting, row: Record<string, unknown>): string {
    const raw = meeting.check_field ? fieldText(row[meeting.check_field]) : "";
    return meeting.check_mode === "suffix4" ? (raw.length >= 4 ? raw.slice(-4) : "") : raw;
  }

  private async pass(db: Query, id: StringRecordId): Promise<Pass | undefined> {
    return statement<Pass>(await db.query("SELECT * FROM $id;", { id }))[0];
  }

  private async row(db: Query, pass: Pass, meeting: Meeting): Promise<Record<string, unknown> | undefined> {
    const sheet = await this.sheet(db, meeting.roster_sheet).catch((cause: unknown) => {
      if (cause instanceof HttpError && cause.status === 404) return undefined;
      throw cause;
    });
    if (!sheet || !String(pass.roster_row).startsWith(`${sheet.table_name}:`)) return;
    return statement<Record<string, unknown>>(await db.query("SELECT * FROM $row;", { row: pass.roster_row }))[0];
  }

  private async audit(db: Query, action: string, target: RecordId, actor: string) {
    await db.query("CREATE roster_meeting_audit SET action = $action, target = $target, actor = $actor;", { action, target, actor });
  }

  private async failure(db: Query, pass: Pass | undefined, hash: string, now: number): Promise<never> {
    this.limits.fail(hash, now);
    if (!pass) {
      await this.audit(db, "verify_failed", new RecordId(PASS_TABLE, "unknown"), "anonymous");
    } else {
      const previousWindow = dateTimeTimestamp(pass.failure_window_at);
      const inWindow = previousWindow > now - WINDOW;
      const failures = inWindow ? pass.failure_count + 1 : 1;
      await db.query(`
        BEGIN TRANSACTION;
        UPDATE $id SET failure_count = $failures, last_attempt_at = $at, failure_window_at = $window, locked_until = $until;
        CREATE roster_meeting_audit SET action = "verify_failed", target = $id, actor = $actor;
        COMMIT TRANSACTION;
      `, {
        id: pass.id, failures, at: new DateTime(new Date(now)), window: new DateTime(new Date(inWindow ? previousWindow : now)),
        until: failures >= 5 ? new DateTime(new Date(now + LOCK)) : undefined, actor: rosterSubject(pass.id),
      });
    }
    throw rosterDenied();
  }

  async verify(input: { pass: string; code: string; check?: string }, source: string) {
    const pepper = this.assertEnabled();
    const hash = hashToken(input.pass, pepper);
    this.limits.start(source, hash, this.now());
    const slug = passPattern.exec(input.pass)?.[1];
    const workspace = slug && await this.resolveWorkspace(slug);
    if (!slug || !workspace) {
      this.limits.fail(hash, this.now());
      throw rosterDenied();
    }
    const database = workspace.dbName;
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const now = this.now();
      this.limits.check(hash, now);
      const [pass] = statement<Pass>(await db.query("SELECT * FROM roster_meeting_pass WHERE pass_hash = $hash LIMIT 1;", { hash }));
      if (dateTimeTimestamp(pass?.locked_until) > now) throw rateLimited();
      const meeting = pass && await this.meeting(db, pass.meeting);
      const row = pass?.status === "active" && pass.lease_state !== "kicked" && dateTimeTimestamp(pass.expires_at) > now
        && meeting && this.open(meeting, now) && await this.row(db, pass, meeting);
      const salt = pass?.code_hash.split(".")[0] || "invalid";
      const correct = safeTextEqual(codeDigest(input.code, pepper, salt), pass?.code_hash ?? "invalid");
      const name = row && meeting && fieldText(row[meeting.display_field]);
      const expectedCheck = row && meeting && this.checkValue(meeting, row);
      if (!pass || !meeting || !row || !name || !correct
        || (meeting.check_field && (!expectedCheck || !safeTextEqual(expectedCheck, input.check?.trim() ?? "")))) {
        return this.failure(db, pass, hash, now);
      }
      if (meeting.room_id && this.media?.isRosterLocked(database, meeting.room_id)) throw rosterRoomLocked();
      const current = Boolean(pass.lease_session && pass.lease_state !== "kicked" && dateTimeTimestamp(pass.lease_expires_at) > now);
      const subject = rosterSubject(pass.id);
      if (meeting.concurrency === "reject" && current) {
        await this.audit(db, "rejected_concurrent", pass.id, subject);
        throw new HttpError(409, "meeting-roster-concurrent", "此参会凭证已有活动会话");
      }
      const exp = Math.min(now + SESSION_TTL, dateTimeTimestamp(pass.expires_at), dateTimeTimestamp(meeting.ends_at) || Infinity);
      const state = meeting.admission === "waiting" ? "waiting" : "admitted";
      const session = generateToken();
      const generation = pass.lease_generation + 1;
      try {
        await db.query(`
          BEGIN TRANSACTION;
          IF !(SELECT VALUE id FROM $meeting WHERE status = "open" AND (ends_at = NONE OR ends_at > $at))[0] {
            THROW "roster-pass-conflict";
          };
          LET $updated = UPDATE $id SET lease_generation = $generation, lease_session = $leaseId,
            lease_state = $state, lease_expires_at = $deadline, lease_verified_at = $at, opened_at = opened_at ?? $at,
            failure_count = 0, last_attempt_at = NONE, failure_window_at = NONE, locked_until = NONE
            WHERE status = "active" AND lease_generation = $previous AND expires_at > $at RETURN id;
          IF array::len($updated) != 1 { THROW "roster-pass-conflict"; };
          CREATE roster_meeting_audit SET action = "verify_ok", target = $id, actor = $subject;
          IF $current { CREATE roster_meeting_audit SET action = "replaced", target = $id, actor = $subject; };
          COMMIT TRANSACTION;
        `, {
          meeting: meeting.id, id: pass.id, previous: pass.lease_generation, subject, current,
          generation, leaseId: session, state, at: new DateTime(new Date(now)),
          deadline: new DateTime(new Date(state === "waiting" ? Math.min(exp, now + WINDOW) : exp)),
        });
      } catch (cause) { writeError(cause); }
      if (pass.lease_session && meeting.room_id) await this.media?.dropRoster(database, meeting.room_id, subject);
      this.limits.success(hash);
      const payload = Buffer.from(JSON.stringify({ slug, meeting: String(meeting.id), pass: String(pass.id), generation, session, exp } satisfies Cookie)).toString("base64url");
      return { cookie: `${payload}.${signPayload(payload, pepper)}`, maxAge: Math.floor((exp - now) / 1000), state, title: meeting.title, name,
        check_label: meeting.check_label };
    });
  }

  private readCookie(raw: string | undefined): Cookie {
    const pepper = this.assertEnabled();
    if (!raw || raw.length > 2048) throw rosterDenied();
    const [payload, signature, trailing] = raw.split(".");
    if (!payload || !signature || trailing !== undefined || !verifySignature(payload, signature, pepper)) throw rosterDenied();
    let body: unknown;
    try { body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown; }
    catch { throw rosterDenied(); }
    const parsed = cookieSchema.safeParse(body);
    if (!parsed.success || parsed.data.exp <= this.now()) throw rosterDenied();
    return parsed.data;
  }

  private async withSession<T>(raw: string | undefined, run: (data: {
    database: string; meeting: Meeting; pass: Pass; state: LeaseState | "replaced" | "revoked"; name: string;
  }) => Promise<T>) {
    const cookie = this.readCookie(raw);
    const workspace = await this.resolveWorkspace(cookie.slug);
    if (!workspace) throw rosterDenied();
    const database = workspace.dbName;
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const pass = await this.pass(db, record(PASS_TABLE, cookie.pass));
      const meeting = pass && String(pass.meeting) === cookie.meeting && await this.meeting(db, pass.meeting);
      if (!pass || !meeting || cookie.exp <= this.now()) throw rosterDenied();
      const row = await this.row(db, pass, meeting);
      const name = row && fieldText(row[meeting.display_field]);
      let state: LeaseState | "replaced" | "revoked";
      if (!this.open(meeting) || pass.status !== "active" || dateTimeTimestamp(pass.expires_at) <= this.now() || !name) state = "revoked";
      else if (pass.lease_session !== cookie.session) state = "replaced";
      else if (pass.lease_state === "kicked") state = "kicked";
      else if (!pass.lease_state || pass.lease_generation !== cookie.generation || dateTimeTimestamp(pass.lease_expires_at) <= this.now()) state = "revoked";
      else state = pass.lease_state;
      return run({ database, meeting, pass, state, name: name || "" });
    });
  }

  session(raw: string | undefined) {
    return this.withSession(raw, async ({ database, state, meeting, name }) => ({
      state, title: meeting.title, name, check_label: meeting.check_label,
      ended: meeting.status === "closed" ? true : undefined,
      focus: state === "admitted" && meeting.room_id ? this.media?.rosterFocus(database, meeting.room_id) : undefined,
    }));
  }

  credentials(raw: string | undefined) {
    return this.withSession(raw, async ({ database, meeting, pass, state, name }) => {
      if (state !== "admitted" || !pass.lease_session) throw rosterDenied();
      if (!meeting.room_id || !this.media?.hasRosterRoom(database, meeting.room_id)) throw noRoom();
      return this.media.rosterCredentials({
        workspace: database, subject: rosterSubject(pass.id), name, expiresAt: dateTimeTimestamp(pass.lease_expires_at),
      }, meeting.room_id, pass.lease_session);
    });
  }

  raiseHand(raw: string | undefined) {
    return this.withSession(raw, async ({ database, meeting, pass, state }) => {
      if (state !== "admitted" || !pass.lease_session) throw rosterDenied();
      if (!meeting.room_id || !this.media) throw noRoom();
      await this.media.raiseRosterHand(database, meeting.room_id, rosterSubject(pass.id), pass.lease_session);
    });
  }

  moderation(actor: Actor, meetingId: string, command?: RosterMeetingCommand) {
    this.assertEnabled();
    return this.withWorkspace(actor.workspace, async () => {
      const db = await this.getSession(actor.workspace);
      const meeting = await this.requireMeeting(db, meetingId);
      if (!this.open(meeting) || !meeting.room_id || !this.media) throw noRoom();
      if (command) return this.media.moderateRoster(actor, meeting.room_id, command);
      return this.media.rosterModeration(actor, meeting.room_id);
    });
  }

  private async meetingPass(db: Query, meeting: Meeting, passId: string) {
    const pass = await this.pass(db, record(PASS_TABLE, passId));
    if (!pass || String(pass.meeting) !== String(meeting.id)) throw missing();
    return pass;
  }

  async revoke(database: string, meetingId: string, passId: string, actor: string) {
    this.assertEnabled();
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const meeting = await this.requireMeeting(db, meetingId);
      const pass = await this.meetingPass(db, meeting, passId);
      try {
        await db.query(`
          BEGIN TRANSACTION;
          LET $changed = UPDATE $id SET status = "revoked", lease_generation += 1 WHERE status = "active" RETURN id;
          IF array::len($changed) = 1 { CREATE roster_meeting_audit SET action = "revoked", target = $id, actor = $actor; };
          COMMIT TRANSACTION;
        `, { id: pass.id, actor });
      } catch (cause) { writeError(cause); }
      if (meeting.room_id) await this.media?.dropRoster(database, meeting.room_id, rosterSubject(pass.id));
    });
  }

  async waiting(database: string, meetingId: string) {
    this.assertEnabled();
    const db = await this.getSession(database);
    const meeting = await this.requireMeeting(db, meetingId);
    if (meeting.admission !== "waiting") throw conflict();
    const entries = statement<Pass>(await db.query(`
      SELECT id, roster_row, opened_at, lease_generation
        FROM roster_meeting_pass WHERE meeting = $meeting AND status = "active"
          AND lease_state = "waiting" AND lease_expires_at > time::now() AND expires_at > time::now() ORDER BY opened_at;
    `, { meeting: meeting.id }));
    if (!this.open(meeting)) return [];
    return Promise.all(entries.map(async (pass) => {
      const row = await this.row(db, pass, meeting);
      return { id: String(pass.id), generation: pass.lease_generation, name: row ? fieldText(row[meeting.display_field]) : "" };
    }));
  }

  async decide(database: string, meetingId: string, passId: string, generation: number, action: "admit" | "reject" | "kick", actor: string) {
    this.assertEnabled();
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const meeting = await this.requireMeeting(db, meetingId);
      const pass = await this.meetingPass(db, meeting, passId);
      const now = this.now();
      if (!this.open(meeting, now) || pass.status !== "active" || pass.lease_generation !== generation
        || !pass.lease_session || !pass.lease_state || pass.lease_state === "kicked"
        || (action !== "kick" && (meeting.admission !== "waiting" || pass.lease_state !== "waiting"
          || dateTimeTimestamp(pass.lease_expires_at) <= now))) throw conflict();
      const admitting = action === "admit";
      if (admitting && meeting.room_id && this.media?.isRosterLocked(database, meeting.room_id)) throw rosterRoomLocked();
      const deadline = Math.min(dateTimeTimestamp(pass.lease_verified_at) + SESSION_TTL, dateTimeTimestamp(pass.expires_at),
        dateTimeTimestamp(meeting.ends_at) || Infinity);
      try {
        await db.query(`
          BEGIN TRANSACTION;
          IF (SELECT VALUE status FROM $meeting)[0] != "open" { THROW "roster-pass-conflict"; };
          LET $changed = UPDATE $id SET lease_state = $state, lease_expires_at = $until, lease_generation = $next
            WHERE status = "active" AND lease_generation = $generation RETURN id;
          IF array::len($changed) != 1 { THROW "roster-pass-conflict"; };
          IF $audit != NONE { CREATE roster_meeting_audit SET action = $audit, target = $id, actor = $actor; };
          COMMIT TRANSACTION;
        `, {
          id: pass.id, meeting: meeting.id, generation, next: admitting ? generation : generation + 1,
          state: admitting ? "admitted" : "kicked", until: new DateTime(new Date(admitting ? deadline : now)),
          audit: admitting ? undefined : "kicked", actor,
        });
      } catch (cause) { writeError(cause); }
      if (!admitting && meeting.room_id) await this.media?.dropRoster(database, meeting.room_id, rosterSubject(pass.id));
    });
  }

  start(actor: Actor, meetingId: string) {
    this.assertEnabled();
    return this.withWorkspace(actor.workspace, async () => {
      const media = this.media;
      if (!media) throw unavailable();
      const db = await this.getSession(actor.workspace);
      const meeting = await this.requireMeeting(db, meetingId);
      if (!this.open(meeting) || (meeting.room_id && media.hasRosterRoom(actor.workspace, meeting.room_id))) throw conflict();
      const sheet = await this.sheet(db, meeting.roster_sheet);
      const [count] = statement<{ total: number }>(await db.query(
        "SELECT count() AS total FROM type::table($table) GROUP ALL;", { table: sheet.table_name },
      ));
      const room = await media.startRoster(actor, Math.min(media.maxSeats, (count?.total ?? 0) + 1),
        dateTimeTimestamp(meeting.ends_at) || undefined);
      try {
        const rows = statement(await db.query(
          "UPDATE $id SET room_id = $room WHERE status = 'open' AND room_id = $previous RETURN id;",
          { id: meeting.id, room: room.id, previous: meeting.room_id },
        ));
        if (rows.length !== 1) throw conflict();
      } catch (cause) {
        await media.endRoster(actor.workspace, room.id);
        writeError(cause);
      }
      return room;
    });
  }

  end(actor: Actor, meetingId: string) {
    this.assertEnabled();
    const database = actor.workspace;
    return this.withWorkspace(database, async () => {
      const db = await this.getSession(database);
      const meeting = await this.requireMeeting(db, meetingId);
      if (meeting.room_id && this.media?.hasRosterRoom(database, meeting.room_id)) this.media.assertRosterHost(actor, meeting.room_id);
      await db.query("UPDATE $id SET status = 'closed';", { id: meeting.id });
      if (meeting.room_id) await this.media?.endRoster(database, meeting.room_id);
    });
  }
}
