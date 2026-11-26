import { describe, expect, test } from "bun:test";
import { classifyDeviceError, LocalMedia, type MediaDevicesLike } from "./local-media";

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  contentHint = "";
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
}

function stream(...tracks: FakeTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream;
}

function denied(): never {
  throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
}

describe("本地设备生命周期", () => {
  test("摄像头被拒绝不影响麦克风，stopAll 停止全部轨道", async () => {
    const opened: FakeTrack[] = [];
    const devices: MediaDevicesLike = {
      async getUserMedia(constraints) {
        if (constraints?.video) denied();
        const track = new FakeTrack("audio");
        opened.push(track);
        return stream(track);
      },
      async getDisplayMedia() {
        const track = new FakeTrack("video");
        opened.push(track);
        return stream(track);
      },
    };
    const media = new LocalMedia(devices);
    const changes: Array<[string, boolean]> = [];
    media.subscribe((source, track) => changes.push([source, track !== null]));
    expect(await media.start("camera")).toBe("denied");
    expect(await media.start("microphone")).toBeNull();
    expect(await media.start("screen")).toBeNull();
    expect(media.has("camera")).toBe(false);
    media.stopAll();
    expect(opened.every((t) => t.readyState === "ended")).toBe(true);
    expect(media.has("microphone") || media.has("screen")).toBe(false);
    expect(changes).toEqual([
      ["microphone", true],
      ["screen", true],
      ["microphone", false],
      ["screen", false],
    ]);
  });

  test("用户在浏览器控件里停止共享时同步移除", async () => {
    const track = new FakeTrack("video");
    const media = new LocalMedia({ getUserMedia: async () => stream(), getDisplayMedia: async () => stream(track) });
    await media.start("screen");
    track.dispatchEvent(new Event("ended"));
    expect(media.has("screen")).toBe(false);
  });

  test("设备错误分类", () => {
    expect(classifyDeviceError({ name: "NotFoundError" })).toBe("not-found");
    expect(classifyDeviceError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyDeviceError(new Error("x"))).toBe("unknown");
  });
});
