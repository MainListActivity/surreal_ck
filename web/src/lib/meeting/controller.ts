import type { EdgeOptions, EdgeState, MeetingEdgeLike } from "./edge";
import type { MeetingIce } from "./ice";
import {
  meetingErrorCode,
  meetingErrorMessage,
  type MeetingRoom,
  type MeetingRoute,
  type MeetingRpc,
  type MeetingSdpRow,
  type MeetingSnapshot,
} from "./rpc";
import { MEETING_SOURCES, sha256Hex, type MeetingSource } from "./sdp";

/**
 * Web 会议状态机：复用原生 V1 网状房间（069-native-meeting.surql）与原生 actor 的节奏
 *（较小 join_id 发起、首轮 Direct、失败后 Relay、35s 协商超时、8s 续租）。
 * 会议授权以服务端快照为准：房间结束、本端被移出或请求被拒都立即关闭所有边并回调释放设备。
 */
export const TICK_MS = 1500;
export const RENEW_AFTER_MS = 8000;
export const ATTEMPT_TTL_MS = 35_000;
export const EDGE_RETRY_MS = 15_000;
export const RELAY_RETRY_MS = 2000;
export const ICE_REFRESH_MARGIN_MS = 60_000;
export const MAX_PEERS = 3;

export type MeetingPhase = "idle" | "joining" | "live" | "ended" | "left" | "removed" | "failed";

export type PeerStatus = "waiting" | "connecting" | "direct" | "relay" | "failed";

export type MeetingPeerView = {
  member: string;
  joinId: string;
  status: PeerStatus;
  chat: boolean;
  tracks: Partial<Record<MeetingSource, MediaStreamTrack>>;
};

export type ChatEntry = {
  id: number;
  member: string;
  self: boolean;
  text: string;
  at: number;
};

export type MeetingView = {
  phase: MeetingPhase;
  room: MeetingRoom | null;
  localJoin: string | null;
  localMember: string | null;
  isHost: boolean;
  peers: MeetingPeerView[];
  overflow: number;
  chat: ChatEntry[];
  error: string | null;
};

export type MeetingControllerDeps = {
  rpc: MeetingRpc;
  fetchIce(): Promise<MeetingIce>;
  createEdge(options: EdgeOptions): MeetingEdgeLike;
  localTrack(source: MeetingSource): MediaStreamTrack | null;
  randomId(): string;
  now?: () => number;
  /** 进入任一终态（离会 / 散会 / 被移出 / 失败）时调用，用于立即释放本地设备。 */
  onTerminated?: (phase: MeetingPhase) => void;
  autoTick?: boolean;
  authorizationLeaseMs?: number;
};

type EdgeEntry = {
  edge: MeetingEdgeLike;
  attempt: number;
  nonce: string;
  offerHash: string | null;
  startedAt: number;
  answered: boolean;
  chat: boolean;
  tracks: Partial<Record<MeetingSource, MediaStreamTrack>>;
};

type PeerEntry = {
  member: string;
  joinId: string;
  lastAttempt: number;
  lastRoute: MeetingRoute | null;
  retryAt: number;
  edge: EdgeEntry | null;
  failed: boolean;
};

const MAX_CHAT_HISTORY = 200;

export class MeetingController {
  #deps: MeetingControllerDeps;
  #now: () => number;
  #listeners = new Set<(view: MeetingView) => void>();
  #phase: MeetingPhase = "idle";
  #snapshot: MeetingSnapshot | null = null;
  #localJoin: string | null = null;
  #peers = new Map<string, PeerEntry>();
  #overflow = 0;
  #chat: ChatEntry[] = [];
  #chatSeq = 0;
  #error: string | null = null;
  #ice: MeetingIce | null = null;
  #lastRenew = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #leaseTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #heartbeatBusy = false;
  #ticking = false;

  constructor(deps: MeetingControllerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get view(): MeetingView {
    const snapshot = this.#snapshot;
    const localMember = this.#localMember();
    return {
      phase: this.#phase,
      room: snapshot?.room ?? null,
      localJoin: this.#localJoin,
      localMember,
      isHost: snapshot !== null && localMember !== null && snapshot.room.host === localMember,
      peers: [...this.#peers.values()].map((peer) => ({
        member: peer.member,
        joinId: peer.joinId,
        status: peerStatus(peer),
        chat: peer.edge?.chat === true && peer.edge.edge.chatOpen,
        tracks: { ...(peer.edge?.tracks ?? {}) },
      })),
      overflow: this.#overflow,
      chat: [...this.#chat],
      error: this.#error,
    };
  }

  subscribe(listener: (view: MeetingView) => void): () => void {
    this.#listeners.add(listener);
    listener(this.view);
    return () => this.#listeners.delete(listener);
  }

  async create(): Promise<void> {
    const joinId = this.#deps.randomId();
    await this.#enter(() => this.#deps.rpc.create(joinId), joinId);
  }

  async join(code: string): Promise<void> {
    const joinId = this.#deps.randomId();
    await this.#enter(() => this.#deps.rpc.join(code.trim(), joinId), joinId);
  }

  async attach(snapshot: MeetingSnapshot, authorizedAt: number): Promise<void> {
    await this.#enter(() => Promise.resolve(snapshot), snapshot.local_join ?? "", authorizedAt);
  }

  async invite(memberKeys: string[]): Promise<string[]> {
    const room = this.#snapshot?.room;
    if (!room || this.#phase !== "live") return [];
    const result = await this.#deps.rpc.invite(room.id, memberKeys, this.#localJoin ?? undefined);
    return result.invited;
  }

  /** 本地媒体源变化（开关摄像头 / 共享屏幕）时替换所有边上的发送轨道，不重新协商。 */
  async setLocalTrack(source: MeetingSource, track: MediaStreamTrack | null): Promise<void> {
    await Promise.allSettled(
      [...this.#peers.values()].flatMap((peer) => (peer.edge ? [peer.edge.edge.setTrack(source, track)] : [])),
    );
  }

  /** 返回送达的边数；原生客户端的会议边没有 chat-v1 通道，不计入。 */
  sendChat(text: string): number {
    const trimmed = text.trim();
    if (!trimmed || this.#phase !== "live") return 0;
    let delivered = 0;
    for (const peer of this.#peers.values()) {
      if (peer.edge?.edge.sendChat(trimmed)) delivered++;
    }
    this.#pushChat(this.#localMember() ?? "", true, trimmed);
    return delivered;
  }

  async leave(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!this.#terminate("left")) return;
    if (room && joinId) await this.#deps.rpc.leave(room.id, joinId).catch(() => undefined);
  }

  /** 关闭标签页：同步释放设备与连接，离会信令尽力发送，异常退出由服务端租约收敛。 */
  leaveOnUnload(): void {
    void this.leave();
  }

  async end(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!room || !joinId || !this.view.isHost) return;
    try {
      await this.#deps.rpc.end(room.id, joinId);
    } catch (error) {
      this.#error = meetingErrorMessage(error);
      this.#emit();
      return;
    }
    this.#terminate("ended");
  }

  async tick(): Promise<void> {
    if (this.#ticking || this.#phase !== "live") return;
    this.#ticking = true;
    try {
      if (!this.#deps.authorizationLeaseMs) await this.#refreshSnapshot();
      if (this.#phase !== "live") return;
      await this.#ensureIce();
      await this.#pollOffers();
      if (this.#phase !== "live") return;
      await this.#pollAnswers();
      if (this.#phase !== "live") return;
      this.#expireAttempts();
      await this.#startOffers();
    } catch (error) {
      this.#handleError(error);
    } finally {
      this.#ticking = false;
      this.#emit();
    }
  }

  async #enter(open: () => Promise<MeetingSnapshot>, joinId: string, authorizedAt = this.#now()): Promise<void> {
    if (this.#phase !== "idle") throw new Error("会议控制器只能进入一次");
    this.#phase = "joining";
    this.#emit();
    try {
      const snapshot = await open();
      const local = snapshot.local_join ?? joinId;
      if (!local || !snapshot.members.some((m) => m.join_id === local)) throw new Error("会议快照缺少本端成员");
      this.#localJoin = local;
      this.#lastRenew = this.#now();
      this.#phase = "live";
      this.#applySnapshot(snapshot);
      if (this.#deps.authorizationLeaseMs) {
        this.#setAuthorizationDeadline(authorizedAt);
        this.#heartbeat = setInterval(() => void this.#checkAuthorization(), 650);
      }
      this.#ice = await this.#deps.fetchIce().catch(() => null);
    } catch (error) {
      this.#error = meetingErrorMessage(error);
      this.#terminate("failed");
      throw error;
    }
    this.#emit();
    if (this.#deps.autoTick !== false && this.#phase === "live") {
      this.#timer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    }
  }

  async #checkAuthorization(): Promise<void> {
    if (this.#heartbeatBusy || this.#phase !== "live") return;
    const started = this.#now();
    this.#heartbeatBusy = true;
    try {
      await this.#refreshSnapshot();
      if (this.#phase === "live") this.#setAuthorizationDeadline(started);
    } catch (error) {
      this.#handleError(error);
    } finally {
      this.#heartbeatBusy = false;
      this.#emit();
    }
  }

  #setAuthorizationDeadline(started: number): void {
    const lease = this.#deps.authorizationLeaseMs;
    if (!lease) return;
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    const remaining = started + lease - this.#now();
    if (remaining <= 0) this.#terminate("removed");
    else this.#leaseTimer = setTimeout(() => this.#terminate("removed"), remaining);
  }

  async #refreshSnapshot(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!room || !joinId) return;
    const renew = this.#now() - this.#lastRenew >= RENEW_AFTER_MS;
    const snapshot = renew
      ? await this.#deps.rpc.renew(room.id, joinId)
      : await this.#deps.rpc.snapshot(room.id, joinId);
    if (this.#phase !== "live") return;
    if (renew) this.#lastRenew = this.#now();
    this.#applySnapshot(snapshot);
  }

  #applySnapshot(snapshot: MeetingSnapshot): void {
    this.#snapshot = snapshot;
    const local = this.#localJoin;
    if (snapshot.room.status !== "open") {
      this.#terminate("ended");
      return;
    }
    if (!local || !snapshot.members.some((m) => m.join_id === local)) {
      this.#terminate("removed");
      return;
    }
    const others = snapshot.members
      .filter((m) => m.join_id !== local)
      .sort((a, b) => (a.join_id < b.join_id ? -1 : 1));
    const visible = others.slice(0, MAX_PEERS);
    this.#overflow = others.length - visible.length;
    const keep = new Set(visible.map((m) => m.join_id));
    for (const [joinId, peer] of this.#peers) {
      if (!keep.has(joinId)) {
        peer.edge?.edge.close();
        this.#peers.delete(joinId);
      }
    }
    for (const member of visible) {
      if (!this.#peers.has(member.join_id)) {
        this.#peers.set(member.join_id, {
          member: member.member,
          joinId: member.join_id,
          lastAttempt: 0,
          lastRoute: null,
          retryAt: 0,
          edge: null,
          failed: false,
        });
      }
    }
  }

  async #ensureIce(): Promise<void> {
    if (this.#ice && this.#ice.expiresAtMs - this.#now() > ICE_REFRESH_MARGIN_MS) return;
    this.#ice = await this.#deps.fetchIce().catch(() => this.#ice);
  }

  #isOfferer(peer: PeerEntry): boolean {
    return this.#localJoin !== null && this.#localJoin < peer.joinId;
  }

  #nextRoute(peer: PeerEntry): MeetingRoute | null {
    if (peer.lastAttempt === 0) return "direct";
    const relay = (this.#ice?.relay.length ?? 0) > 0;
    if (peer.lastRoute === "direct" && relay) return "relay";
    if (peer.lastRoute === "relay" && relay) return "relay";
    return "direct";
  }

  #newEdge(peer: PeerEntry, role: "offerer" | "answerer", route: MeetingRoute): EdgeEntry {
    const ice = this.#ice;
    const entry: EdgeEntry = {
      edge: null as unknown as MeetingEdgeLike,
      attempt: 0,
      nonce: "",
      offerHash: null,
      startedAt: this.#now(),
      answered: false,
      chat: false,
      tracks: {},
    };
    entry.edge = this.#deps.createEdge({
      role,
      route,
      iceServers: route === "relay" ? (ice?.relay ?? []) : (ice?.direct ?? []),
      localTrack: (source) => this.#deps.localTrack(source),
      events: {
        onState: (state: EdgeState) => {
          if (peer.edge !== entry) return;
          if (state === "failed") this.#failEdge(peer);
          this.#emit();
        },
        onTrack: (source, track) => {
          if (peer.edge !== entry) return;
          entry.tracks[source] = track;
          track.addEventListener("ended", () => {
            if (entry.tracks[source] === track) delete entry.tracks[source];
            this.#emit();
          });
          this.#emit();
        },
        onChatOpen: () => {
          entry.chat = true;
          this.#emit();
        },
        onChat: (text) => {
          if (peer.edge === entry) this.#pushChat(peer.member, false, text);
        },
      },
    });
    return entry;
  }

  async #startOffers(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!room || !joinId) return;
    for (const peer of this.#peers.values()) {
      if (!this.#isOfferer(peer) || peer.edge || this.#now() < peer.retryAt) continue;
      const route = this.#nextRoute(peer);
      if (!route) continue;
      const attempt = peer.lastAttempt + 1;
      const entry = this.#newEdge(peer, "offerer", route);
      peer.edge = entry;
      peer.lastAttempt = attempt;
      peer.lastRoute = route;
      peer.failed = false;
      try {
        const offer = await entry.edge.createOffer();
        if (peer.edge !== entry || this.#phase !== "live") return;
        entry.attempt = attempt;
        entry.nonce = this.#deps.randomId();
        entry.offerHash = await sha256Hex(offer);
        entry.startedAt = this.#now();
        await this.#deps.rpc.postOffer({
          room: room.id,
          joinId,
          peerJoinId: peer.joinId,
          attempt,
          nonce: entry.nonce,
          route,
          offer,
          offerHash: entry.offerHash,
        });
      } catch (error) {
        if (meetingErrorCode(error) === "rate_limited") {
          peer.lastAttempt = attempt - 1;
          peer.edge = null;
          entry.edge.close();
          return;
        }
        this.#failEdge(peer);
      }
    }
  }

  async #pollOffers(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!room || !joinId) return;
    const rows = await this.#deps.rpc.pollOffers(room.id, joinId);
    for (const row of rows) {
      const peer = this.#peers.get(row.sender_join);
      if (!peer || row.recipient_join !== joinId || this.#isOfferer(peer) || row.answer) continue;
      if (row.attempt <= peer.lastAttempt) continue;
      if (row.route === "relay" && (this.#ice?.relay.length ?? 0) === 0) continue;
      if ((await sha256Hex(row.offer)) !== row.offer_hash) continue;
      peer.edge?.edge.close();
      const entry = this.#newEdge(peer, "answerer", row.route);
      peer.edge = entry;
      peer.lastAttempt = row.attempt;
      peer.lastRoute = row.route;
      peer.failed = false;
      entry.attempt = row.attempt;
      entry.nonce = row.nonce;
      entry.offerHash = row.offer_hash;
      try {
        const answer = await entry.edge.acceptOffer(row.offer);
        if (peer.edge !== entry || this.#phase !== "live") return;
        await this.#deps.rpc.postAnswer({
          room: room.id,
          joinId,
          peerJoinId: peer.joinId,
          attempt: row.attempt,
          nonce: row.nonce,
          wireId: row.id,
          route: row.route,
          offerHash: row.offer_hash,
          answer,
          answerHash: await sha256Hex(answer),
        });
        entry.answered = true;
        entry.startedAt = this.#now();
      } catch {
        this.#failEdge(peer);
      }
    }
  }

  async #pollAnswers(): Promise<void> {
    const room = this.#snapshot?.room;
    const joinId = this.#localJoin;
    if (!room || !joinId) return;
    const pending = [...this.#peers.values()].some((p) => p.edge && p.edge.offerHash && !p.edge.answered && this.#isOfferer(p));
    if (!pending) return;
    const rows = await this.#deps.rpc.pollAnswers(room.id, joinId);
    for (const row of rows) await this.#acceptAnswer(row, joinId);
  }

  async #acceptAnswer(row: MeetingSdpRow, joinId: string): Promise<void> {
    const peer = this.#peers.get(row.recipient_join);
    const entry = peer?.edge;
    if (!peer || !entry || entry.answered || row.sender_join !== joinId) return;
    if (row.attempt !== entry.attempt || row.nonce !== entry.nonce || row.offer_hash !== entry.offerHash) return;
    if (!row.answer || !row.answer_hash || (await sha256Hex(row.answer)) !== row.answer_hash) return;
    entry.answered = true;
    try {
      await entry.edge.acceptAnswer(row.answer);
      entry.startedAt = this.#now();
    } catch {
      this.#failEdge(peer);
    }
  }

  #expireAttempts(): void {
    for (const peer of this.#peers.values()) {
      const entry = peer.edge;
      if (!entry || entry.edge.state === "connected") continue;
      if (this.#now() - entry.startedAt >= ATTEMPT_TTL_MS) this.#failEdge(peer);
    }
  }

  #failEdge(peer: PeerEntry): void {
    const entry = peer.edge;
    peer.edge = null;
    peer.failed = true;
    entry?.edge.close();
    const relayNext = peer.lastRoute === "direct" && (this.#ice?.relay.length ?? 0) > 0;
    peer.retryAt = this.#now() + (relayNext ? RELAY_RETRY_MS : EDGE_RETRY_MS);
  }

  #handleError(error: unknown): void {
    const code = meetingErrorCode(error);
    if (code === "not_found" || code === "expired") {
      this.#terminate(code === "expired" ? "ended" : "removed");
      return;
    }
    if (code === "denied" && this.#deps.authorizationLeaseMs) {
      this.#terminate("removed");
      return;
    }
    if (code === "rate_limited" || code === "conflict") return;
    this.#error = meetingErrorMessage(error);
  }

  #terminate(phase: MeetingPhase): boolean {
    if (this.#phase === "left" || this.#phase === "ended" || this.#phase === "removed" || this.#phase === "failed") {
      return false;
    }
    this.#phase = phase;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#leaseTimer) clearTimeout(this.#leaseTimer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#leaseTimer = null;
    this.#heartbeat = null;
    for (const peer of this.#peers.values()) peer.edge?.edge.close();
    this.#peers.clear();
    this.#deps.onTerminated?.(phase);
    this.#emit();
    return true;
  }

  #localMember(): string | null {
    const local = this.#localJoin;
    return this.#snapshot?.members.find((m) => m.join_id === local)?.member ?? null;
  }

  #pushChat(member: string, self: boolean, text: string): void {
    this.#chat = [...this.#chat, { id: ++this.#chatSeq, member, self, text, at: this.#now() }].slice(-MAX_CHAT_HISTORY);
    this.#emit();
  }

  #emit(): void {
    const view = this.view;
    for (const listener of this.#listeners) listener(view);
  }
}

function peerStatus(peer: PeerEntry): PeerStatus {
  const entry = peer.edge;
  if (!entry) return peer.failed ? "failed" : "waiting";
  if (entry.edge.state === "connected") return entry.edge.route === "relay" ? "relay" : "direct";
  return "connecting";
}

export function hasAnyTrack(view: MeetingPeerView): boolean {
  return MEETING_SOURCES.some((source) => view.tracks[source] !== undefined);
}
