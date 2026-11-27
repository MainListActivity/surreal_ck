import type { MeetingSource } from "./sdp";

/**
 * 本地设备生命周期：默认全部关闭，只有用户操作才申请权限与取流；
 * 离会 / 散会 / 关闭标签页时 `stopAll()` 立即 stop 所有轨道，让浏览器设备指示灯熄灭。
 */
export type DeviceError = "denied" | "not-found" | "busy" | "unsupported" | "unknown";

export type MediaDevicesLike = Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "getDisplayMedia">>;

export function classifyDeviceError(error: unknown): DeviceError {
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "not-found";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  return "unknown";
}

export const DEVICE_ERROR_MESSAGES: Record<DeviceError, string> = {
  denied: "权限被拒绝，可在浏览器地址栏的站点设置中重新允许",
  "not-found": "未检测到设备",
  busy: "设备被其他应用占用",
  unsupported: "当前浏览器不支持该设备",
  unknown: "无法打开设备",
};

export type LocalMediaListener = (source: MeetingSource, track: MediaStreamTrack | null) => void;

export class LocalMedia {
  #devices: MediaDevicesLike;
  #tracks = new Map<MeetingSource, MediaStreamTrack>();
  #listeners = new Set<LocalMediaListener>();

  constructor(devices: MediaDevicesLike) {
    this.#devices = devices;
  }

  track(source: MeetingSource): MediaStreamTrack | null {
    return this.#tracks.get(source) ?? null;
  }

  has(source: MeetingSource): boolean {
    return this.#tracks.has(source);
  }

  subscribe(listener: LocalMediaListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 打开单个源；失败返回分类错误，不影响其他源（摄像头拒绝仍可纯音频入会）。 */
  async start(source: MeetingSource): Promise<DeviceError | null> {
    if (this.#tracks.has(source)) return null;
    let stream: MediaStream;
    try {
      if (source === "screen") {
        if (!this.#devices.getDisplayMedia) return "unsupported";
        stream = await this.#devices.getDisplayMedia({ video: true, audio: false });
      } else if (source === "microphone") {
        stream = await this.#devices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } else {
        stream = await this.#devices.getUserMedia({
          audio: false,
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } },
        });
      }
    } catch (error) {
      return classifyDeviceError(error);
    }
    const [track, ...extra] = source === "microphone" ? stream.getAudioTracks() : stream.getVideoTracks();
    for (const other of [...extra, ...stream.getTracks().filter((t) => t !== track)]) other.stop();
    if (!track) return "not-found";
    if (source === "screen") track.contentHint = "detail";
    // 用户在浏览器自带控件里停止共享 / 拔出设备时同步收敛。
    track.addEventListener("ended", () => {
      if (this.#tracks.get(source) === track) this.stop(source);
    });
    this.#tracks.set(source, track);
    this.#emit(source, track);
    return null;
  }

  stop(source: MeetingSource): void {
    const track = this.#tracks.get(source);
    if (!track) return;
    this.#tracks.delete(source);
    track.stop();
    this.#emit(source, null);
  }

  stopAll(): void {
    for (const source of [...this.#tracks.keys()]) this.stop(source);
  }

  #emit(source: MeetingSource, track: MediaStreamTrack | null): void {
    for (const listener of this.#listeners) listener(source, track);
  }
}

/** 麦克风音量条：返回 0..1 的电平读取器与释放函数。 */
export function createLevelMeter(track: MediaStreamTrack): { read(): number; close(): void } {
  const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!AudioCtx) return { read: () => 0, close: () => undefined };
  const context = new AudioCtx();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(new MediaStream([track]));
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  return {
    read() {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const value of buffer) sum += ((value - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buffer.length) * 3);
    },
    close() {
      source.disconnect();
      void context.close();
    },
  };
}
