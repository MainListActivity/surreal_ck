import { expect, test } from "bun:test";
import { Track } from "livekit-client";
import { selectedMeetingSubscriptions } from "./sfu";

test("roster screen focus accepts a co-host share but prefers the host and never selects a co-host camera", () => {
  const cohostShare = { id: "cohost-share", identity: "cohost", host: false, cohost: true, source: Track.Source.ScreenShare };
  const cohostCamera = { ...cohostShare, id: "cohost-camera", source: Track.Source.Camera };
  expect(selectedMeetingSubscriptions([cohostShare, cohostCamera], [], "mobile", "screen")).toEqual(new Set(["cohost-share"]));
  expect(selectedMeetingSubscriptions([cohostShare, cohostCamera], [], "desktop", "speaker")).toEqual(new Set());
  expect(selectedMeetingSubscriptions([cohostShare, ...publications], [], "mobile", "screen")).toEqual(new Set(["host-mic", "host-share"]));
});

const publications = [
  { id: "host-mic", identity: "host", host: true, source: Track.Source.Microphone },
  { id: "host-share", identity: "host", host: true, source: Track.Source.ScreenShare },
  { id: "speaker-mic", identity: "speaker", host: false, source: Track.Source.Microphone },
  { id: "speaker-camera", identity: "speaker", host: false, source: Track.Source.Camera },
  { id: "speaker-share", identity: "speaker", host: false, source: Track.Source.ScreenShare },
];

test("手机随发言人切换音频，仅保留一条共享画面", () => {
  expect(selectedMeetingSubscriptions(publications, [], "mobile")).toEqual(new Set(["host-mic", "host-share"]));
  expect(selectedMeetingSubscriptions(publications, ["speaker"], "mobile")).toEqual(new Set(["speaker-mic", "host-share"]));
});

test("纯音频模式不订阅摄像头或共享画面", () => {
  expect(selectedMeetingSubscriptions(publications, ["speaker"], "audio")).toEqual(new Set(["speaker-mic"]));
});

test("名册会议在桌面和手机均优先主持人共享，锁定后不随发言者跳转", () => {
  const hostCamera = { id: "host-camera", identity: "host", host: true, source: Track.Source.Camera };
  for (const policy of ["desktop", "mobile"] as const) {
    const focused = [...publications, hostCamera];
    const audio = policy === "desktop" ? ["host-mic", "speaker-mic"] : ["speaker-mic"];
    expect(selectedMeetingSubscriptions(focused, ["speaker"], policy, "auto")).toEqual(new Set([...audio, "host-share"]));
    expect(selectedMeetingSubscriptions(focused, ["speaker"], policy, "screen")).toEqual(new Set([...audio, "host-share"]));
    expect(selectedMeetingSubscriptions(focused, ["speaker"], policy, "speaker")).toEqual(new Set([...audio, "host-camera"]));
    expect(selectedMeetingSubscriptions(focused.filter((track) => track.id !== "host-share"), ["speaker"], policy, "screen"))
      .toEqual(new Set(audio));
  }
});
