import type { MeetingSfuCredentials } from "@surreal-ck/shared";

export type RosterSession = {
  state: "waiting" | "admitted" | "replaced" | "kicked" | "revoked";
  title: string;
  name: string;
  check_label?: string;
};

export class RosterRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function rosterExitMessage(state: RosterSession["state"]): string {
  if (state === "replaced") return "您的参会凭证已在其他设备登录，本端已下线";
  if (state === "kicked" || state === "revoked") return "您已被移出会议";
  return "";
}

export function rosterVerifyMessage(error: unknown): string {
  const status = error instanceof RosterRequestError ? error.status : undefined;
  if (status === 429) return "尝试次数过多，请稍后再试";
  if (status === 409) return "此参会凭证已有活动会话";
  if (status === 401) return "无法验证参会凭证";
  return "名册会议服务暂不可用，请稍后再试";
}

export async function rosterRequest(path: string, options: {
  method?: "GET" | "POST" | "DELETE"; body?: unknown; token?: string; fetcher?: typeof fetch;
} = {}): Promise<Response> {
  const { method = "GET", body, token, fetcher = fetch } = options;
  const response = await fetcher(path, {
    method, credentials: token ? "omit" : "same-origin", cache: "no-store",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new RosterRequestError(response.status, data?.error?.message ?? "名册会议请求失败");
  }
  return response;
}

export function createPublicRosterApi(fetcher?: typeof fetch) {
  const request = async <T>(operation: string, method?: "POST", body?: unknown): Promise<T> =>
    (await rosterRequest(`/api/meeting/roster/${operation}`, { method, body, fetcher })).json() as Promise<T>;
  return {
    verify: (pass: string, code: string, check?: string) =>
      request<RosterSession>("verify", "POST", { pass, code, check }),
    session: () => request<RosterSession>("session"),
    credentials: () => request<MeetingSfuCredentials>("credentials", "POST"),
  };
}
