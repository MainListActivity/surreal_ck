import { randomUUID } from "node:crypto";
import {
  MEETING_SFU_SIGNAL_PATH,
  type MeetingSfuCredentials,
  type MeetingSfuParticipant,
  type MeetingSfuRole,
  type MeetingSfuRoom,
} from "@surreal-ck/shared";
import { jwtVerify } from "jose";
import { AccessToken, RoomServiceClient, TrackSource, type VideoGrant } from "livekit-server-sdk";
import { HttpError } from "../http-error";

const ROOM_PREFIX = "ck-meeting-";
const ROOM_SECONDS = 2 * 60 * 60;
const JOIN_TOKEN_SECONDS = 90;
const LEASE_MS = 2 * 60_000;
const TICK_MS = 5_000;

export type SfuActor = { workspace: string; subject: string; name: string; expiresAt: number; workspaceAdmin?: boolean };
type Room = MeetingSfuRoom & {
  workspace: string;
  host: string;
  closing: boolean;
  managed: boolean;
  participants: Map<string, SfuParticipant>;
  bySubject: Map<string, SfuParticipant>;
};
type SfuParticipant = MeetingSfuParticipant & {
  leaseUntil: number;
  pendingRemoval: boolean;
  closeSignal?: () => void;
  externalSession?: string;
};

type Admin = Pick<RoomServiceClient, "createRoom" | "listRooms" | "deleteRoom" | "removeParticipant" | "updateParticipant">;
type Config = { privateUrl: string; signalUrl: string; key: string; secret: string; maxSeats: number };
export type SignalLease = { roomId: string; identity: string; publisher: boolean };

const denied = () => new HttpError(403, "meeting-sfu-denied", "没有权限进入或管理此大会");
const full = () => new HttpError(409, "meeting-sfu-capacity", "私有会议容量已满，请减少预计人数或稍后重试");
const unavailable = () => new HttpError(503, "meeting-sfu-unavailable", "私有会议服务暂不可用，请稍后重试");
const expired = () => new HttpError(401, "meeting-sfu-session-expired", "登录会话已过期");

function permissions(role: MeetingSfuRole) {
  return {
    canSubscribe: true,
    canPublish: role !== "listener",
    canPublishData: false,
    canUpdateOwnMetadata: false,
    ...(role === "listener" ? {} : { canPublishSources: [
      TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO,
    ] }),
  };
}

function participantView({ id, memberSubject, name, role, revoked }: SfuParticipant): MeetingSfuParticipant {
  return { id, memberSubject, name, role, revoked };
}

function roomView({ id, seats, expiresAt, topology }: Room): MeetingSfuRoom {
  return { id, seats, expiresAt, topology };
}

export function isSfuRoomId(id: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(id);
}

export class PrivateMeetingSfu {
  private readonly rooms = new Map<string, Room>();
  private readonly admin: Admin;
  private readonly verifyKey: Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  private sweeping = false;
  private ticker?: ReturnType<typeof setInterval>;
  readonly signalUrl: string;

  constructor(
    private readonly config: Config,
    admin?: Admin,
    private readonly now = Date.now,
  ) {
    this.signalUrl = new URL(MEETING_SFU_SIGNAL_PATH, config.signalUrl).toString();
    this.admin = admin ?? new RoomServiceClient(config.privateUrl, config.key, config.secret, { requestTimeout: 3 });
    this.verifyKey = new TextEncoder().encode(config.secret);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async initialize(): Promise<void> {
    if (this.ready) return;
    // 进程重启时旧租约不恢复。先关闭专用实例上的旧 CK 房间，再分配任何新容量。
    await this.upstream(async () => {
      const rooms = (await this.admin.listRooms()).filter((room) => room.name.startsWith(ROOM_PREFIX));
      await Promise.all(rooms.map((room) => this.deleteRoom(room.name)));
    });
    this.ready = true;
    this.ticker = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      void this.serial(() => this.sweep())
        .catch(() => undefined).finally(() => { this.sweeping = false; });
    }, TICK_MS);
    this.ticker.unref();
  }

  private async upstream<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw unavailable();
    }
  }

  private async ignoreNotFound(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "not_found") throw error;
    }
  }

  private async deleteRoom(name: string): Promise<void> {
    await this.ignoreNotFound(() => this.admin.deleteRoom(name));
  }

  private async dropParticipant(room: Room, participant: SfuParticipant): Promise<void> {
    participant.pendingRemoval = true;
    participant.closeSignal?.();
    await this.ignoreNotFound(() => this.admin.removeParticipant(ROOM_PREFIX + room.id, participant.id));
    participant.pendingRemoval = false;
  }

  private async closeRoom(room: Room): Promise<void> {
    room.closing = true;
    for (const participant of room.participants.values()) participant.closeSignal?.();
    await this.deleteRoom(ROOM_PREFIX + room.id);
    this.rooms.delete(room.id);
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    await Promise.all([...this.rooms.values()].map(async (room) => {
      if (room.closing || room.expiresAt <= now) {
        await this.closeRoom(room).catch(() => undefined);
        return;
      }
      await Promise.all([...room.participants.values()].map(async (participant) => {
        if (participant.pendingRemoval || (participant.leaseUntil !== 0 && participant.leaseUntil <= now)) {
          participant.leaseUntil = 0;
          const removal = participant.externalSession ? this.removeRoster(room, participant) : this.dropParticipant(room, participant);
          await removal.catch(() => undefined);
        }
      }));
    }));
  }

  get maxSeats(): number { return this.config.maxSeats; }

  create(actor: SfuActor, seats: number) {
    return this.createRoom(actor, seats, false);
  }

  startRoster(actor: SfuActor, seats: number, endsAt?: number) {
    return this.createRoom(actor, seats, true, endsAt);
  }

  private createRoom(actor: SfuActor, seats: number, managed: boolean, endsAt = Infinity) {
    return this.serial(async () => {
      await this.initialize();
      if (Math.min(actor.expiresAt, endsAt) <= this.now()) throw expired();
      if (!Number.isInteger(seats) || seats < 1 || seats > this.config.maxSeats) throw full();
      const reserved = [...this.rooms.values()].reduce((sum, room) => sum + room.seats, 0);
      if (seats + reserved > this.config.maxSeats) throw full();
      const id = randomUUID();
      const room: Room = {
        id, seats, topology: "sfu", workspace: actor.workspace, host: actor.subject,
        expiresAt: Math.min(endsAt, this.now() + ROOM_SECONDS * 1000), closing: false, managed,
        participants: new Map(), bySubject: new Map(),
      };
      this.addParticipant(room, actor.subject, actor.name, "host");
      // 先保留容量；若上游创建请求超时，后台删除可能已创建的房间后才释放。
      this.rooms.set(id, room);
      try {
        await this.upstream(() => this.admin.createRoom({
          name: ROOM_PREFIX + id, maxParticipants: seats,
          emptyTimeout: ROOM_SECONDS, departureTimeout: ROOM_SECONDS,
        }));
      } catch (error) {
        room.closing = true;
        throw error;
      }
      return roomView(room);
    });
  }

  private addParticipant(room: Room, subject: string, name: string, role: MeetingSfuRole): SfuParticipant {
    if (room.participants.size >= room.seats) throw full();
    const participant = {
      id: randomUUID(), memberSubject: subject, name, role, revoked: false, leaseUntil: 0, pendingRemoval: false,
    };
    room.bySubject.set(subject, participant);
    room.participants.set(participant.id, participant);
    return participant;
  }

  private access(actor: SfuActor, roomId: string, host = false): Room {
    const room = this.rooms.get(roomId);
    if (actor.expiresAt <= this.now()) throw expired();
    if (!room || room.closing || room.expiresAt <= this.now() || room.workspace !== actor.workspace
      || (host && room.host !== actor.subject)) throw denied();
    return room;
  }

  invite(actor: SfuActor, roomId: string, subject: string, role: Exclude<MeetingSfuRole, "host">) {
    return this.serial(async () => {
      const room = this.access(actor, roomId, true);
      if (room.managed) throw denied();
      const existing = room.bySubject.get(subject);
      if (existing?.revoked || existing?.role === "host" || (existing && existing.role !== role)) throw denied();
      return participantView(existing ?? this.addParticipant(room, subject, "参会人", role));
    });
  }

  participants(actor: SfuActor, roomId: string) {
    const room = this.access(actor, roomId, true);
    if (room.managed && !actor.workspaceAdmin) throw denied();
    return [...room.participants.values()].map(participantView);
  }

  credentials(actor: SfuActor, roomId: string): Promise<MeetingSfuCredentials> {
    return this.serial(async () => {
      const room = this.access(actor, roomId);
      const participant = room.bySubject.get(actor.subject);
      if (!participant || participant.externalSession || (room.managed && !actor.workspaceAdmin)) throw denied();
      return this.mintCredentials(room, participant, actor);
    });
  }

  private async mintCredentials(room: Room, participant: SfuParticipant, actor: SfuActor): Promise<MeetingSfuCredentials> {
    if (participant.revoked || participant.pendingRemoval) throw denied();
    const now = this.now();
    const leaseExpiresAt = Math.min(actor.expiresAt, room.expiresAt, now + LEASE_MS);
    const ttl = Math.min(JOIN_TOKEN_SECONDS, Math.floor((leaseExpiresAt - now) / 1000));
    if (ttl < 1) throw expired();
    participant.name = actor.name;
    const jwt = new AccessToken(this.config.key, this.config.secret, {
      identity: participant.id, name: participant.name, metadata: participant.role === "host" ? "host" : undefined, ttl,
    });
    jwt.addGrant({ room: ROOM_PREFIX + room.id, roomJoin: true, ...permissions(participant.role) });
    const token = await jwt.toJwt();
    participant.leaseUntil = leaseExpiresAt;
    return { url: this.signalUrl, token, leaseExpiresAt, role: participant.role };
  }

  hasRosterRoom(workspace: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return Boolean(room?.managed && room.workspace === workspace && !room.closing && room.expiresAt > this.now());
  }

  rosterCredentials(actor: SfuActor, roomId: string, session: string): Promise<MeetingSfuCredentials> {
    return this.serial(async () => {
      const room = this.access(actor, roomId);
      if (!room.managed) throw denied();
      let participant = room.bySubject.get(actor.subject);
      if (participant && !participant.externalSession) throw denied();
      if (participant && participant.externalSession !== session) {
        await this.removeRoster(room, participant);
        participant = undefined;
      }
      if (!participant) {
        participant = this.addParticipant(room, actor.subject, actor.name, "listener");
        participant.externalSession = session;
      }
      return this.mintCredentials(room, participant, actor);
    });
  }

  private async removeRoster(room: Room, target: SfuParticipant): Promise<void> {
    target.revoked = true;
    target.leaseUntil = 0;
    await this.upstream(() => this.dropParticipant(room, target));
    room.bySubject.delete(target.memberSubject);
    room.participants.delete(target.id);
  }

  dropRoster(workspace: string, roomId: string, subject: string) {
    return this.serial(async () => {
      const room = this.rooms.get(roomId);
      if (!room?.managed || room.workspace !== workspace) return;
      const target = room.bySubject.get(subject);
      if (target?.externalSession) await this.removeRoster(room, target);
    });
  }

  endRoster(workspace: string, roomId: string) {
    return this.serial(async () => {
      const room = this.rooms.get(roomId);
      if (room?.managed && room.workspace === workspace) await this.upstream(() => this.closeRoom(room));
    });
  }

  kick(actor: SfuActor, roomId: string, identity: string) {
    return this.serial(async () => {
      const room = this.access(actor, roomId, true);
      if (room.managed) throw denied();
      const target = room.participants.get(identity);
      if (!target || target.role === "host") throw denied();
      target.revoked = true;
      target.leaseUntil = 0;
      await this.upstream(() => this.dropParticipant(room, target));
    });
  }

  stopPublishing(actor: SfuActor, roomId: string, identity: string) {
    return this.serial(async () => {
      const room = this.access(actor, roomId, true);
      if (room.managed) throw denied();
      const target = room.participants.get(identity);
      if (!target || target.role === "host" || target.revoked) throw denied();
      target.role = "listener";
      // 关闭旧身份正在协商的连接，防止旧发布授权与上游权限更新并发。
      target.closeSignal?.();
      try {
        await this.upstream(() => this.ignoreNotFound(() => this.admin.updateParticipant(
          ROOM_PREFIX + roomId, target.id, { permission: permissions("listener") },
        )));
      } catch (error) {
        await this.dropParticipant(room, target).catch(() => undefined);
        throw error;
      }
    });
  }

  end(actor: SfuActor, roomId: string) {
    return this.serial(async () => {
      const room = this.rooms.get(roomId);
      if (room?.managed) throw denied();
      if (room?.closing && room.workspace === actor.workspace && room.host === actor.subject && actor.expiresAt > this.now()) {
        await this.upstream(() => this.closeRoom(room));
        return;
      }
      const active = this.access(actor, roomId, true);
      await this.upstream(() => this.closeRoom(active));
    });
  }

  async authorizeSignal(token: string): Promise<SignalLease | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.verifyKey, {
        algorithms: ["HS256"], issuer: this.config.key, requiredClaims: ["sub", "exp"], currentDate: new Date(this.now()),
      });
      const grant = payload.video as VideoGrant | undefined;
      if (grant?.roomJoin !== true || !grant.room?.startsWith(ROOM_PREFIX) || !payload.sub) return;
      const lease = {
        roomId: grant.room.slice(ROOM_PREFIX.length),
        identity: payload.sub,
        publisher: grant.canPublish !== false || Boolean(grant.canPublishSources?.length),
      };
      return this.findLease(lease) ? lease : undefined;
    } catch {
      return undefined;
    }
  }

  private findLease({ roomId, identity, publisher }: SignalLease): SfuParticipant | undefined {
    const room = this.rooms.get(roomId);
    if (!room || room.closing || room.expiresAt <= this.now()) return;
    const participant = room.participants.get(identity);
    if (!participant || participant.revoked || participant.pendingRemoval || participant.leaseUntil <= this.now()
      || (participant.role === "listener" && publisher)) return;
    return participant;
  }

  attachSignal(lease: SignalLease, close: () => void): (() => void) | undefined {
    const participant = this.findLease(lease);
    if (!participant) return;
    participant.closeSignal?.();
    participant.closeSignal = close;
    return () => {
      if (participant.closeSignal === close) participant.closeSignal = undefined;
    };
  }

  close(): void {
    if (this.ticker) clearInterval(this.ticker);
  }
}
