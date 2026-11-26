export type MeetingIceServer =
  | { urls: string[]; username?: never; credential?: never }
  | { urls: string[]; username: string; credential: string };

export type MeetingIceServersResponse = {
  iceServers: MeetingIceServer[];
  ttlSeconds: number;
  expiresAt: string;
};
