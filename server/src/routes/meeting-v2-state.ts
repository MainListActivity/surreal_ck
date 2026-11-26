import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http-error";

const hour = 60 * 60_000;
const waitingTtl = 15 * 60_000;
const memberLease = 12_000;
const guestLease = 2_500;
const maxMesh = 4;
const maxRequests = 64;
const signalTtl = 35_000;
const hex = /^[0-9a-f]{64}$/u;
const digits = /^[0-9]{6}$/u;
const dbName = /^ws_[a-z0-9]{12}$/u;
const opaque = () => randomBytes(32).toString("hex");

type Participant = { member: string; join_id: string; lease: number; name?: string };
type Guest = { name: string; expires: number; status: "waiting" | "admitted" | "revoked"; connection?: string };
type Signal = {
  id: string; sender: string; recipient: string; sender_join: string; recipient_join: string;
  attempt: number; nonce: string; route: "direct" | "relay"; offer: string; offer_hash: string;
  answer: string | null; answer_hash: string | null; expires: number;
};
export type MeetingRoomState = {
  host: string; expires: number; ended: boolean; version: number; locked: boolean;
  invite: { digest: string; code: string | null; expires: number } | null;
  members: Participant[]; invitees: string[]; guests: Record<string, Guest>; signals: Record<string, Signal>;
};
export interface MeetingStore {
  read(database: string, id: string): Promise<{ revision: number; state: MeetingRoomState } | null>;
  write(database: string, id: string, revision: number | null, state: MeetingRoomState): Promise<boolean>;
}
export type Scope = { database: string; room: string };
export type Command = Record<string, unknown>;
type GuestSession = Scope & { digest: string };
export const invalidInvite = () => new HttpError(403, "meeting-guest-invalid", "访客链接或访问码无效");
const revoked = () => new HttpError(401, "meeting-guest-revoked", "访客会话已失效");
const denied = () => new HttpError(403, "meeting-denied", "会议请求被拒绝");
const expired = () => new HttpError(409, "meeting-expired", "会议已结束或已过期");
const full = () => new HttpError(409, "meeting-full", "当前会议人数已满");
const conflict = () => new HttpError(409, "meeting-conflict", "会议状态冲突");

export function commandObject(value: unknown): Command {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Command : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function meshLease(state: MeetingRoomState, now: number, guest?: Guest): number {
  return Math.min(state.expires, now + (guest ? guestLease : memberLease), guest?.expires ?? state.expires);
}

function prune(state: MeetingRoomState, now: number): boolean {
  const previous = state.members.length;
  state.members = state.members.filter((entry) => entry.lease > now);
  const changed = previous !== state.members.length;
  if (changed) state.version++;
  for (const [id, edge] of Object.entries(state.signals)) {
    if (edge.expires <= now || !state.members.some((p) => p.join_id === edge.sender_join)
      || !state.members.some((p) => p.join_id === edge.recipient_join)) delete state.signals[id];
  }
  return changed;
}

function snapshot(scope: Scope, state: MeetingRoomState, local: Participant, now: number, guest: boolean) {
  return {
    workspace: guest ? "meeting" : scope.database,
    room: {
      id: scope.room,
      code: guest ? "GUEST000" : `V2${scope.room.toUpperCase()}`,
      host: state.host,
      status: state.ended ? "ended" : "open",
      version: state.version,
      expires_unix: Math.floor(state.expires / 1000),
    },
    local_join: local.join_id,
    server_unix: Math.floor(now / 1000),
    members: (state.ended ? [] : state.members).map((p) => ({
      member: p.member, join_id: p.join_id, lease_expires_unix: Math.ceil(p.lease / 1000),
    })),
  };
}

function viewSignal(scope: Scope, signal: Signal, now: number, guest: boolean) {
  const { expires, ...row } = signal;
  return { ...row, workspace: guest ? "meeting" : scope.database, room: scope.room,
    expires_unix: Math.floor(expires / 1000), server_unix: Math.floor(now / 1000) };
}

function sdp(command: Command, kind: "offer" | "answer"): { body: string; hash: string } {
  const body = text(command[kind]);
  const hash = text(command[`${kind}_hash`]);
  if (!hex.test(hash) || body.length > 49_152 || !/^[\x20-\x7e]+$/u.test(body)
    || createHash("sha256").update(body).digest("hex") !== hash) throw denied();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw denied();
  }
  const data = commandObject(parsed);
  const value = text(data.sdp);
  if (Object.keys(data).length !== 2 || data.type !== kind || !value.startsWith("v=0\r\n")
    || !["\r\nm=", "\r\na=fingerprint:sha-256 ", "\r\na=ice-ufrag:", "\r\na=ice-pwd:"].every((part) => value.includes(part))) throw denied();
  return { body, hash };
}

function signal(scope: Scope, state: MeetingRoomState, local: Participant, command: Command, now: number, guest: boolean) {
  const op = command.op;
  const join = local.join_id;
  if (op === "poll_offers" || op === "poll_answers") {
    return Object.values(state.signals).filter((row) => op === "poll_offers"
      ? row.recipient_join === join && row.answer === null
      : row.sender_join === join && row.answer !== null).map((row) => viewSignal(scope, row, now, guest));
  }
  if (op !== "post_offer" && op !== "post_answer") throw denied();
  const peer = state.members.find((p) => p.join_id === command.peer_join_id);
  const offer = op === "post_offer";
  if (!peer || (offer ? join >= peer.join_id : join <= peer.join_id)) throw denied();
  const { attempt, nonce, route } = command;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 4_294_967_295
    || typeof nonce !== "string" || !hex.test(nonce) || (route !== "direct" && route !== "relay")) throw denied();
  const sender = offer ? local : peer;
  const recipient = offer ? peer : local;
  const key = `${sender.join_id}:${recipient.join_id}`;
  let row = state.signals[key];
  if (offer) {
    const data = sdp(command, "offer");
    if (row && row.attempt >= attempt) {
      if (row.attempt !== attempt || row.nonce !== nonce || row.offer_hash !== data.hash || row.route !== route) throw conflict();
    } else {
      row = { id: opaque(), sender: sender.member, recipient: recipient.member, sender_join: sender.join_id, recipient_join: recipient.join_id,
        attempt, nonce, route, offer: data.body, offer_hash: data.hash, answer: null, answer_hash: null, expires: now + signalTtl };
      state.signals[key] = row;
    }
  } else {
    const data = sdp(command, "answer");
    if (!row || row.id !== command.id || row.attempt !== attempt || row.nonce !== nonce || row.route !== route
      || row.offer_hash !== command.offer_hash || (row.answer_hash !== null && row.answer_hash !== data.hash)) throw conflict();
    row.answer = data.body;
    row.answer_hash = data.hash;
  }
  return viewSignal(scope, row, now, guest);
}

export class MeetingV2 {
  constructor(private readonly store: MeetingStore, private readonly key: string, private readonly clock = Date.now) {}

  digest(domain: string, value: string): string {
    return createHmac("sha256", this.key).update(JSON.stringify(["meeting-v2", domain, value])).digest("hex");
  }

  member(database: string, subject: string): string {
    return `member:${this.digest(database, subject)}`;
  }

  parseScope(value: string): Scope | null {
    const [database, room, ...rest] = value.split(".");
    return database && room && rest.length === 0 && dbName.test(database) && hex.test(room) ? { database, room } : null;
  }

  session(value: string): GuestSession | null {
    const [scope, secret, mac, ...rest] = value.split("~");
    const parsed = this.parseScope(scope ?? "");
    return parsed && secret && mac && !rest.length && hex.test(secret)
      && equal(this.digest("cookie", `${scope}~${secret}`), mac) ? { ...parsed, digest: this.digest("guest", secret) } : null;
  }

  async #change<T>(scope: Scope, action: (state: MeetingRoomState, now: number) => { value: T; write?: boolean }, missing = denied): Promise<T> {
    for (let i = 0; i < 12; i++) {
      const row = await this.store.read(scope.database, scope.room);
      if (!row) throw missing();
      const now = this.clock();
      const { value, write } = action(row.state, now);
      if (!write || await this.store.write(scope.database, scope.room, row.revision, row.state)) return value;
      await Bun.sleep(2 * (i + 1));
    }
    throw conflict();
  }

  async memberCommand(database: string, member: string, command: Command): Promise<unknown> {
    const op = command.op;
    const room = op === "create" ? text(command.nonce)
      : op === "join" ? text(command.code).match(/^V2([0-9A-F]{64})$/u)?.[1]?.toLowerCase() ?? ""
        : text(command.room);
    const join = op === "create" ? room : text(command.join_id);
    if (op === "capability") return { version: "meeting_v2", member };
    if (!hex.test(room) || !hex.test(join)) throw denied();
    const scope = { database, room };
    if (op === "create") {
      const now = this.clock();
      const local = { member, join_id: join, lease: now + memberLease };
      const state: MeetingRoomState = { host: member, expires: now + 2 * hour, ended: false, version: 1, locked: false,
        invite: null, members: [local], invitees: [], guests: {}, signals: {} };
      if (await this.store.write(database, room, null, state)) return snapshot(scope, state, local, now, false);
      throw conflict();
    }
    return this.#change<unknown>(scope, (state, now) => {
      if (state.expires <= now || state.ended) throw expired();
      const pruned = prune(state, now);
      const host = state.host === member;
      const current = state.members.find((p) => p.member === member);
      if (op === "join") {
        if (!host && !state.invitees.includes(member)) throw denied();
        if (state.members.some((p) => p.member !== member && p.join_id === join)) throw conflict();
        if (!current && state.members.length >= maxMesh) throw full();
        const local = { member, join_id: join, lease: meshLease(state, now) };
        state.members = [...state.members.filter((p) => p.member !== member), local];
        state.version++;
        return { value: snapshot(scope, state, local, now, false), write: true };
      }
      if (!current || current.join_id !== join) throw denied();
      if (op === "snapshot" || op === "renew") {
        current.lease = meshLease(state, now);
        return { value: snapshot(scope, state, current, now, false), write: true };
      }
      if (op === "leave") {
        state.members = state.members.filter((p) => p !== current);
        state.version++;
        return { value: null, write: true };
      }
      if (op === "end" || op === "invite_members" || op === "guest_host") {
        if (!host) throw denied();
        if (op === "end") {
          state.ended = true;
          state.members = [];
          state.signals = {};
          state.guests = {};
          state.invite = null;
          return { value: null, write: true };
        }
        if (op === "invite_members") {
          const invitees = command.recipients;
          if (!Array.isArray(invitees) || invitees.length > maxRequests || !invitees.every((id) => typeof id === "string" && /^member:[0-9a-f]{64}$/u.test(id))) throw denied();
          state.invitees = [...new Set([...state.invitees, ...invitees.map(String)])];
          if (state.invitees.length > maxRequests) throw full();
          return { value: { room, invited: invitees }, write: true };
        }
        return this.#host(scope, state, command, now, pruned);
      }
      return { value: signal(scope, state, current, command, now, false), write: pruned || op === "post_offer" || op === "post_answer" };
    });
  }

  #host(scope: Scope, state: MeetingRoomState, command: Command, now: number, pruned: boolean): { value: unknown; write?: boolean } {
    const action = command.action;
    if (action === "status") {
      return { write: pruned, value: {
        enabled: state.invite !== null && state.invite.expires > now, locked: state.locked,
        expires: state.invite?.expires ?? null,
        guests: Object.entries(state.guests).filter(([, g]) => g.status !== "revoked" && g.expires > now)
          .map(([id, g]) => ({ id, name: g.name, status: g.status })),
      } };
    }
    if (action === "lock" || action === "unlock") {
      state.locked = action === "lock";
      return { value: null, write: true };
    }
    if (action === "rotate" || action === "close") {
      state.members = state.members.filter((p) => !p.member.startsWith("guest:"));
      state.guests = {};
      prune(state, now);
      state.version++;
      state.invite = null;
      if (action === "close") return { value: null, write: true };
      const code = text(command.code);
      if (code && !digits.test(code)) throw denied();
      const token = opaque();
      const digest = this.digest("link", token);
      state.invite = { digest, code: code ? this.digest(digest, code) : null, expires: Math.min(now + 2 * hour, state.expires) };
      return { value: { token: `${scope.database}.${scope.room}.${token}` }, write: true };
    }
    const id = text(command.id);
    if (!hex.test(id)) throw denied();
    const guest = state.guests[id];
    if (!guest || guest.status === "revoked" || guest.expires <= now) throw denied();
    if (action === "admit") {
      if (guest.status !== "waiting" || state.locked || !state.invite || state.invite.expires <= now) throw denied();
      const reserved = Object.entries(state.guests).filter(([key, g]) =>
        g.status === "admitted" && g.expires > now && !state.members.some((p) => p.member === `guest:${key}`)).length;
      if (state.members.length + reserved >= maxMesh) throw full();
      guest.status = "admitted";
      guest.expires = state.invite.expires;
    } else if (action === "reject" || action === "remove") {
      guest.status = "revoked";
      delete guest.connection;
      state.members = state.members.filter((p) => p.member !== `guest:${id}`);
      prune(state, now);
      state.version++;
    } else {
      throw denied();
    }
    return { value: null, write: true };
  }

  async open(token: string, code: string, name: string, oldCookie: string): Promise<string> {
    const [database, room, secret, ...rest] = token.split(".");
    const scope = this.parseScope(`${database}.${room}`);
    if (!scope || !secret || !hex.test(secret) || rest.length) throw invalidInvite();
    const digest = this.digest("link", secret);
    const previous = this.session(oldCookie);
    const session = opaque();
    const payload = `${database}.${room}~${session}`;
    return this.#change(scope, (state, now) => {
      const invite = state.invite;
      const correctCode = equal(this.digest(digest, code), invite?.code ?? this.digest(digest, ""));
      if (!invite || !equal(digest, invite.digest) || !correctCode || invite.expires <= now || state.ended
        || state.locked || !name || name.length > 80) throw invalidInvite();
      if (previous?.database === database && previous.room === room) {
        const guest = state.guests[previous.digest];
        if (guest && guest.status !== "revoked" && guest.expires > now) return { value: oldCookie };
        if (guest?.status === "revoked") throw invalidInvite();
      }
      if (Object.keys(state.guests).length >= maxRequests) throw invalidInvite();
      state.guests[this.digest("guest", session)] = { name, expires: Math.min(invite.expires, now + waitingTtl), status: "waiting" };
      return { value: `${payload}~${this.digest("cookie", payload)}`, write: true };
    }, invalidInvite);
  }

  async guestCommand(cookie: string, command: Command): Promise<unknown> {
    const session = this.session(cookie);
    if (!session) throw revoked();
    const { op } = command;
    return this.#change<unknown>(session, (state, now) => {
      const guest = state.guests[session.digest];
      if (state.ended || !state.invite || state.invite.expires <= now || !guest || guest.status === "revoked" || guest.expires <= now) throw revoked();
      if (op === "status") return { value: { status: guest.status } };
      if (guest.status !== "admitted") throw denied();
      const pruned = prune(state, now);
      const member = `guest:${session.digest}`;
      const current = state.members.find((p) => p.member === member);
      if (op === "connect") {
        if (!current && state.members.length >= maxMesh) throw full();
        const connection = opaque();
        guest.connection = this.digest("connection", connection);
        const local = { member, join_id: opaque(), name: guest.name, lease: meshLease(state, now, guest) };
        state.members = [...state.members.filter((p) => p.member !== member), local];
        state.version++;
        return { value: { connection, snapshot: snapshot(session, state, local, now, true) }, write: true };
      }
      if (!current || !guest.connection || !equal(guest.connection, this.digest("connection", text(command.connection)))) throw revoked();
      if (op === "snapshot" || op === "renew") {
        current.lease = meshLease(state, now, guest);
        return { value: snapshot(session, state, current, now, true), write: true };
      }
      if (op === "leave") {
        state.members = state.members.filter((p) => p !== current);
        delete guest.connection;
        state.version++;
        return { value: null, write: true };
      }
      if (op === "ice") {
        return { value: { opaque: session.digest, expires: guest.expires } };
      }
      return { value: signal(session, state, current, command, now, true), write: pruned || op === "post_offer" || op === "post_answer" };
    }, revoked);
  }
}
