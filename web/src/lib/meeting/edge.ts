import {
  decodeWireSdp,
  encodeWireSdp,
  labelLocalSdp,
  MEETING_SOURCES,
  remoteSourcesByMid,
  type MeetingSource,
} from "./sdp";
import type { MeetingRoute } from "./rpc";

/** 与原生 `native-transport/src/chat.rs` 相同的 DataChannel 标签与限制。 */
export const CHAT_LABEL = "chat-v1";
export const MAX_CHAT_BYTES = 16 * 1024;
const CHAT_BACKPRESSURE = 256 * 1024;
const GATHER_TIMEOUT_MS = 8000;

export type EdgeRole = "offerer" | "answerer";
export type EdgeState = "new" | "connecting" | "connected" | "failed" | "closed";

export type EdgeEvents = {
  onState(state: EdgeState): void;
  onTrack(source: MeetingSource, track: MediaStreamTrack): void;
  onChat(text: string): void;
  onChatOpen(): void;
};

export type EdgeOptions = {
  role: EdgeRole;
  route: MeetingRoute;
  iceServers: RTCIceServer[];
  localTrack(source: MeetingSource): MediaStreamTrack | null;
  events: EdgeEvents;
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
};

export type MeetingEdgeLike = {
  readonly role: EdgeRole;
  readonly route: MeetingRoute;
  readonly state: EdgeState;
  readonly chatOpen: boolean;
  createOffer(): Promise<string>;
  acceptOffer(raw: string): Promise<string>;
  acceptAnswer(raw: string): Promise<void>;
  setTrack(source: MeetingSource, track: MediaStreamTrack | null): Promise<void>;
  sendChat(text: string): boolean;
  close(): void;
};

function preferCodecs(transceiver: RTCRtpTransceiver, kind: "audio" | "video"): void {
  const caps = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.(kind) : null;
  if (!caps || typeof transceiver.setCodecPreferences !== "function") return;
  const wanted = kind === "audio" ? "audio/opus" : "video/vp8";
  const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === wanted);
  if (preferred.length === 0) return;
  try {
    transceiver.setCodecPreferences(preferred);
  } catch {
    // 浏览器不支持改写偏好时保留默认顺序，原生端只应答 Opus / VP8。
  }
}

type PendingTrack = { mid: string | null; track: MediaStreamTrack };

function kindOf(source: MeetingSource): "audio" | "video" {
  return source === "microphone" ? "audio" : "video";
}

/** 浏览器侧单条会议边：固定三路 transceiver（microphone / camera / screen）+ 可选 chat-v1。 */
export class BrowserMeetingEdge implements MeetingEdgeLike {
  readonly role: EdgeRole;
  readonly route: MeetingRoute;
  state: EdgeState = "new";
  #pc: RTCPeerConnection;
  #options: EdgeOptions;
  #localByMid = new Map<string, MeetingSource>();
  #remoteByMid = new Map<string, MeetingSource>();
  #senders = new Map<MeetingSource, RTCRtpSender>();
  #chat: RTCDataChannel | null = null;
  #pendingTracks: PendingTrack[] = [];

  constructor(options: EdgeOptions) {
    this.role = options.role;
    this.route = options.route;
    this.#options = options;
    const config: RTCConfiguration = {
      iceServers: options.iceServers,
      iceTransportPolicy: options.route === "relay" ? "relay" : "all",
      bundlePolicy: "max-bundle",
    };
    this.#pc = options.createPeer ? options.createPeer(config) : new RTCPeerConnection(config);
    this.#pc.addEventListener("connectionstatechange", () => this.#syncState());
    this.#pc.addEventListener("track", (event) => {
      const mid = event.transceiver?.mid ?? null;
      this.#pendingTracks.push({ mid, track: event.track });
      this.#flushTracks();
    });
    this.#pc.addEventListener("datachannel", (event) => {
      if (event.channel.label === CHAT_LABEL && this.role === "answerer") this.#bindChat(event.channel);
      else event.channel.close();
    });
  }

  get chatOpen(): boolean {
    return this.#chat?.readyState === "open";
  }

  async createOffer(): Promise<string> {
    if (this.role !== "offerer") throw new Error("仅发起方可创建 offer");
    for (const source of MEETING_SOURCES) {
      const transceiver = this.#pc.addTransceiver(kindOf(source), { direction: "sendrecv" });
      preferCodecs(transceiver, kindOf(source));
      this.#senders.set(source, transceiver.sender);
      const track = this.#options.localTrack(source);
      if (track) await transceiver.sender.replaceTrack(track);
    }
    this.#bindChat(this.#pc.createDataChannel(CHAT_LABEL, { ordered: true }));
    await this.#pc.setLocalDescription(await this.#pc.createOffer());
    this.#pc.getTransceivers().forEach((t, index) => {
      const source = MEETING_SOURCES[index];
      if (t.mid !== null && source) this.#localByMid.set(t.mid, source);
    });
    return encodeWireSdp("offer", labelLocalSdp(await this.#gathered(), this.#localByMid));
  }

  async acceptOffer(raw: string): Promise<string> {
    if (this.role !== "answerer") throw new Error("仅应答方可接受 offer");
    const sdp = decodeWireSdp("offer", raw);
    this.#remoteByMid = remoteSourcesByMid(sdp);
    await this.#pc.setRemoteDescription({ type: "offer", sdp });
    const fallback = [...MEETING_SOURCES];
    for (const transceiver of this.#pc.getTransceivers()) {
      const mid = transceiver.mid;
      const source = (mid !== null ? this.#remoteByMid.get(mid) : undefined) ?? fallback[0];
      if (!source) continue;
      fallback.splice(fallback.indexOf(source), 1);
      if (mid !== null) this.#localByMid.set(mid, source);
      transceiver.direction = "sendrecv";
      preferCodecs(transceiver, kindOf(source));
      this.#senders.set(source, transceiver.sender);
      const track = this.#options.localTrack(source);
      if (track) await transceiver.sender.replaceTrack(track);
    }
    this.#flushTracks();
    await this.#pc.setLocalDescription(await this.#pc.createAnswer());
    this.#syncState();
    return encodeWireSdp("answer", labelLocalSdp(await this.#gathered(), this.#localByMid));
  }

  async acceptAnswer(raw: string): Promise<void> {
    if (this.role !== "offerer") throw new Error("仅发起方可接受 answer");
    const sdp = decodeWireSdp("answer", raw);
    this.#remoteByMid = remoteSourcesByMid(sdp);
    await this.#pc.setRemoteDescription({ type: "answer", sdp });
    this.#flushTracks();
    this.#syncState();
  }

  async setTrack(source: MeetingSource, track: MediaStreamTrack | null): Promise<void> {
    const sender = this.#senders.get(source);
    if (sender && this.state !== "closed") await sender.replaceTrack(track);
  }

  sendChat(text: string): boolean {
    const channel = this.#chat;
    if (!channel || channel.readyState !== "open") return false;
    if (new TextEncoder().encode(text).length > MAX_CHAT_BYTES) return false;
    if (channel.bufferedAmount > CHAT_BACKPRESSURE) return false;
    channel.send(text);
    return true;
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.#chat?.close();
    for (const transceiver of this.#pc.getTransceivers()) {
      try {
        transceiver.stop();
      } catch {
        // 已关闭的 transceiver 直接忽略。
      }
    }
    this.#pc.close();
    this.#options.events.onState("closed");
  }

  #sourceForMid(mid: string | null): MeetingSource | undefined {
    if (mid === null) return undefined;
    return this.#remoteByMid.get(mid) ?? this.#localByMid.get(mid);
  }

  #flushTracks(): void {
    const waiting: PendingTrack[] = [];
    for (const item of this.#pendingTracks) {
      const source = this.#sourceForMid(item.mid);
      if (source) this.#options.events.onTrack(source, item.track);
      else waiting.push(item);
    }
    this.#pendingTracks = waiting;
  }

  #bindChat(channel: RTCDataChannel): void {
    this.#chat = channel;
    channel.addEventListener("open", () => this.#options.events.onChatOpen());
    channel.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (event.data.length === 0 || new TextEncoder().encode(event.data).length > MAX_CHAT_BYTES) return;
      this.#options.events.onChat(event.data);
    });
  }

  #syncState(): void {
    if (this.state === "closed") return;
    const next: EdgeState =
      this.#pc.connectionState === "connected"
        ? "connected"
        : this.#pc.connectionState === "failed" || this.#pc.connectionState === "closed"
          ? "failed"
          : this.#pc.remoteDescription
            ? "connecting"
            : "new";
    if (next === this.state) return;
    this.state = next;
    this.#options.events.onState(next);
  }

  /** 原生端不支持 trickle ICE：SDP 必须在候选收集完成后一次性交换。 */
  async #gathered(): Promise<string> {
    const pc = this.#pc;
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, GATHER_TIMEOUT_MS);
        function done(): void {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
        function check(): void {
          if (pc.iceGatheringState === "complete") done();
        }
        pc.addEventListener("icegatheringstatechange", check);
      });
    }
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error("本地 SDP 缺失");
    return sdp;
  }
}
