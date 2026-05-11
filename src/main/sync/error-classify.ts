export type SyncErrorKind = "transient" | "semantic";

const TRANSIENT_PATTERNS = [
  /network/i,
  /timeout/i,
  /\b5\d\d\b/,
  /service unavailable/i,
  /connection/i,
  /authenticationfailed/i,
];

const SEMANTIC_PATTERNS = [
  /permission/i,
  /not enough permissions/i,
  /assert/i,
  /reference does not exist/i,
  /record .* does not exist/i,
  /schema/i,
  /field .* not/i,
];

export function classifySyncError(err: unknown): SyncErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  if (SEMANTIC_PATTERNS.some((pattern) => pattern.test(message))) return "semantic";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "transient";
}
