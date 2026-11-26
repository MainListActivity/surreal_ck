/**
 * Web 端与原生 V1 会议（069-native-meeting.surql / native-transport MeetingEdge）共用的 SDP 窄协议：
 * - 线上 SDP 是恰好两个键的 JSON 字符串 `{"type","sdp"}`，ASCII 且不超过 49152 字节；
 * - 哈希是该 JSON 原文的 SHA-256 小写十六进制；
 * - 原生端按远端 `a=msid` 的 track id（microphone / camera / screen）识别三路媒体源。
 */
export type MeetingSource = "microphone" | "camera" | "screen";
export const MEETING_SOURCES: readonly MeetingSource[] = ["microphone", "camera", "screen"];
export const MEETING_STREAM_ID = "native-media";
export const MAX_SDP_JSON_BYTES = 49152;

export type WireSdpKind = "offer" | "answer";

export class MeetingSdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingSdpError";
  }
}

const REQUIRED_SDP_PARTS = [
  "\r\nm=",
  "\r\na=fingerprint:sha-256 ",
  "\r\na=ice-ufrag:",
  "\r\na=ice-pwd:",
] as const;

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/** 与原生 `sdp_hash` 同口径校验 SDP 文本。 */
export function isWireSdp(sdp: string): boolean {
  return sdp.startsWith("v=0\r\n") && REQUIRED_SDP_PARTS.every((part) => sdp.includes(part));
}

/** 编码为线上 JSON；字段顺序与原生 serde 输出一致（type 在前）。 */
export function encodeWireSdp(kind: WireSdpKind, sdp: string): string {
  if (!isWireSdp(sdp)) throw new MeetingSdpError("SDP 缺少必需字段");
  const raw = JSON.stringify({ type: kind, sdp });
  if (raw.length > MAX_SDP_JSON_BYTES || !isAscii(raw)) throw new MeetingSdpError("SDP 超出会议协议限制");
  return raw;
}

/** 解析线上 JSON；多余键、类型不符或 SDP 不完整一律拒绝。 */
export function decodeWireSdp(kind: WireSdpKind, raw: string): string {
  if (raw.length > MAX_SDP_JSON_BYTES || !isAscii(raw)) throw new MeetingSdpError("SDP 超出会议协议限制");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MeetingSdpError("SDP 不是合法 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MeetingSdpError("SDP 不是对象");
  }
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (
    keys.length !== 2 ||
    record.type !== kind ||
    typeof record.sdp !== "string" ||
    !isWireSdp(record.sdp)
  ) {
    throw new MeetingSdpError("SDP 格式不符");
  }
  return record.sdp;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Section = { lines: string[] };

function splitSections(sdp: string): { head: string[]; sections: Section[] } {
  const lines = sdp.split("\r\n");
  if (lines.at(-1) === "") lines.pop();
  const head: string[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    if (line.startsWith("m=")) sections.push({ lines: [line] });
    else if (sections.length === 0) head.push(line);
    else sections[sections.length - 1]!.lines.push(line);
  }
  return { head, sections };
}

function joinSections(head: string[], sections: Section[]): string {
  return [...head, ...sections.flatMap((s) => s.lines)].join("\r\n") + "\r\n";
}

function sectionMid(section: Section): string | null {
  const line = section.lines.find((l) => l.startsWith("a=mid:"));
  return line ? line.slice("a=mid:".length) : null;
}

/**
 * 把本端各媒体段的 msid 改写为原生约定的 `native-media <source>`。
 * 浏览器生成的 track id 是随机 UUID，原生端只认固定 track id；未发送轨道的段也要带上 msid，
 * 以便原生端后续 replaceTrack 后仍能把远端轨道映射到正确源。
 */
export function labelLocalSdp(sdp: string, sourceByMid: ReadonlyMap<string, MeetingSource>): string {
  const { head, sections } = splitSections(sdp);
  for (const section of sections) {
    const mid = sectionMid(section);
    const source = mid === null ? undefined : sourceByMid.get(mid);
    if (!source) continue;
    const msid = `${MEETING_STREAM_ID} ${source}`;
    const kept = section.lines.filter((l) => !l.startsWith("a=msid:"));
    const rewritten = kept.map((line) => line.replace(/^(a=ssrc:\d+ msid:).*$/, `$1${msid}`));
    const midIndex = rewritten.findIndex((l) => l.startsWith("a=mid:"));
    rewritten.splice(midIndex + 1, 0, `a=msid:${msid}`);
    section.lines = rewritten;
  }
  return joinSections(head, sections);
}

/** 从远端 SDP 解析 mid → 媒体源；只接受三种固定 track id。 */
export function remoteSourcesByMid(sdp: string): Map<string, MeetingSource> {
  const result = new Map<string, MeetingSource>();
  for (const section of splitSections(sdp).sections) {
    const mid = sectionMid(section);
    if (mid === null) continue;
    for (const line of section.lines) {
      const match = /^a=(?:ssrc:\d+ )?msid:(\S+) (\S+)$/.exec(line);
      const track = match?.[2];
      if (track && (MEETING_SOURCES as readonly string[]).includes(track)) {
        result.set(mid, track as MeetingSource);
        break;
      }
    }
  }
  return result;
}

/** 按 m 行顺序给出媒体种类与 mid，用于应答方把浏览器 transceiver 与源对齐。 */
export function mediaSections(sdp: string): Array<{ mid: string; kind: string }> {
  return splitSections(sdp).sections.flatMap((section) => {
    const mid = sectionMid(section);
    const kind = section.lines[0]!.slice(2).split(" ")[0] ?? "";
    return mid === null ? [] : [{ mid, kind }];
  });
}
