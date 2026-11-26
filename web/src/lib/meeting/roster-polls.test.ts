import { expect, test } from "bun:test";
import { canCastRosterBallot, type RosterPoll } from "./roster-polls";

test("截止时刻、结束会议和禁止改票都会阻止表决", () => {
  const deadline = "2026-11-26T00:00:00.000Z";
  const end = Date.parse(deadline);
  const poll: RosterPoll = { id: "poll:a", version: "1", title: "议题", deadline, options: [], allowChange: false };
  expect(canCastRosterBallot(poll, end - 1, false)).toBe(true);
  expect(canCastRosterBallot(poll, end, false)).toBe(false);
  expect(canCastRosterBallot(poll, end - 1, true)).toBe(false);
  expect(canCastRosterBallot({ ...poll, deadline: "" }, end - 1, false)).toBe(false);
  const voted = { ...poll, ballot: { option: "yes", at: deadline } };
  expect(canCastRosterBallot(voted, end - 1, false)).toBe(false);
  expect(canCastRosterBallot({ ...voted, allowChange: true }, end - 1, false)).toBe(true);
});
