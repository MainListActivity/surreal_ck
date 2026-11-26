import { expect, test } from "bun:test";
import { Track } from "livekit-client";
import { selectedMeetingSubscriptions } from "./sfu";

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
