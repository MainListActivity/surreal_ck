export const PUBLIC_ACTION = {
  claims: "claims_portal",
  claimsWrite: "claims_write",
  roster: "roster_verify",
  guest: "meeting_guest",
  trial: "trial_request",
} as const;

export const TRIAL_PATH = "/api/public/trial-request";
export const EDGE_IP_HEADER = "x-surreal-ck-client-ip";
export const PUBLIC_LIMIT_SECONDS = 60;

export function publicEntry(path: string) {
  const claims = /^\/api\/claims-portal\/([^/]+)\/([^/]+)\//u.exec(path);
  if (claims) return { area: "claims", target: claims[2] ?? "" } as const;
  if (path.startsWith("/api/meeting/roster/")) return { area: "roster", target: path } as const;
  if (path === "/api/meeting/v2/guest") return { area: "guest", target: path } as const;
  if (path === TRIAL_PATH) return { area: "trial", target: path } as const;
}

export function publicRateLimited(retryAfter = PUBLIC_LIMIT_SECONDS) {
  return Response.json({ error: { code: "public-rate-limited", message: "请求过于频繁，请稍后再试" } }, {
    status: 429,
    headers: { "cache-control": "no-store", "retry-after": String(retryAfter) },
  });
}
