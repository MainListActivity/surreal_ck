import { describe, expect, test } from "bun:test";
import {
  decodeWireSdp,
  encodeWireSdp,
  labelLocalSdp,
  mediaSections,
  remoteSourcesByMid,
  sha256Hex,
  type MeetingSource,
} from "./sdp";

const CHROME_OFFER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1 2 3",
  "a=fingerprint:sha-256 AA:BB",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:efghefghefghefghefghefgh",
  "a=mid:0",
  "a=sendrecv",
  "a=msid:- 6b3f7c0e-uuid-audio",
  "a=ssrc:1111 msid:- 6b3f7c0e-uuid-audio",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:1",
  "a=msid:- 2f0e-uuid-camera",
  "a=ssrc:2222 msid:- 2f0e-uuid-camera",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:2",
  "a=sendrecv",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=mid:3",
  "",
].join("\r\n");

const BY_MID = new Map<string, MeetingSource>([
  ["0", "microphone"],
  ["1", "camera"],
  ["2", "screen"],
]);

describe("会议 SDP 窄协议", () => {
  test("线上 JSON 与原生 serde 同形：type 在前且恰好两个键", () => {
    const raw = encodeWireSdp("offer", CHROME_OFFER);
    expect(raw.startsWith('{"type":"offer","sdp":"v=0')).toBe(true);
    expect(decodeWireSdp("offer", raw)).toBe(CHROME_OFFER);
  });

  test("拒绝多余键、错误类型、缺字段与超长 SDP", () => {
    expect(() => decodeWireSdp("offer", JSON.stringify({ type: "offer", sdp: CHROME_OFFER, x: 1 }))).toThrow();
    expect(() => decodeWireSdp("answer", encodeWireSdp("offer", CHROME_OFFER))).toThrow();
    expect(() => encodeWireSdp("offer", "v=0\r\nm=audio\r\n")).toThrow();
    expect(() => encodeWireSdp("offer", CHROME_OFFER + "a=x:" + "y".repeat(50_000) + "\r\n")).toThrow();
    expect(() => decodeWireSdp("offer", "{not json")).toThrow();
  });

  test("哈希是 JSON 原文的 SHA-256 十六进制", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("改写 msid 为原生固定 track id，包括未发送轨道的段", () => {
    const labeled = labelLocalSdp(CHROME_OFFER, BY_MID);
    expect(labeled).toContain("a=msid:native-media microphone");
    expect(labeled).toContain("a=ssrc:1111 msid:native-media microphone");
    expect(labeled).toContain("a=msid:native-media camera");
    expect(labeled).toContain("a=msid:native-media screen");
    expect(labeled).not.toContain("uuid");
    expect(labeled.endsWith("\r\n")).toBe(true);
    expect([...remoteSourcesByMid(labeled)]).toEqual([...BY_MID]);
  });

  test("解析原生 SDP 的 mid → 源，忽略未知 track id", () => {
    const native = CHROME_OFFER.replace("a=msid:- 2f0e-uuid-camera", "a=msid:native-media camera");
    const sources = remoteSourcesByMid(native);
    expect(sources.get("1")).toBe("camera");
    expect(sources.has("0")).toBe(false);
    expect(mediaSections(native).map((s) => s.kind)).toEqual(["audio", "video", "video", "application"]);
  });
});
