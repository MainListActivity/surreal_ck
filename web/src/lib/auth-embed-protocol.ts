export type AuthEmbedMessage =
  | { source: "maplayer-auth"; type: "success"; returnTo: string }
  | { source: "maplayer-auth"; type: "error"; message: string };

export function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function postAuthEmbedMessage(message: AuthEmbedMessage): void {
  if (!isFramed()) return;
  window.parent.postMessage(message, "*");
}

const FORBIDDEN_RETURN_PATHS = new Set([
  "/auth/login",
  "/auth/callback",
  "/auth/embed",
]);

export function sanitizeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  const path = value.split(/[?#]/, 1)[0];
  if (FORBIDDEN_RETURN_PATHS.has(path)) return "/";
  return value;
}
