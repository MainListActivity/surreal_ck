export type RosterPollOption = { key: string; label: string };
export type RosterPollAgenda = { title: string; options: RosterPollOption[]; allowChange: boolean };
export type RosterPollInput = RosterPollAgenda & { deadline: string };
export type RosterBallot = { option: string; note?: string; at: string };
export type RosterPoll = RosterPollInput & { id: string; version: string; ballot?: RosterBallot };
export type RosterPollResult = RosterPollInput & {
  id: string; version: string; results: (RosterPollOption & { count: number; weight: number })[];
};

export function isPollClosed(deadline: string, now: number): boolean {
  const end = Date.parse(deadline);
  return !Number.isFinite(end) || now >= end;
}

export function canCastRosterBallot(poll: RosterPoll, now: number, ended: boolean): boolean {
  return !ended && !isPollClosed(poll.deadline, now) && (!poll.ballot || poll.allowChange);
}

export function downloadMeetingFile(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|\r\n]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
