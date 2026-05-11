export type QueryableDb = {
  query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T>;
};

let localSessionId: string | null = null;

export function getLocalSessionId(): string {
  localSessionId ??= crypto.randomUUID();
  return localSessionId;
}

export function buildDefineCurrentSessionParamSql(sessionId = getLocalSessionId()): string {
  return `DEFINE PARAM OVERWRITE $current_session_id VALUE '${escapeSurrealString(sessionId)}';`;
}

export async function defineCurrentSessionParam(db: QueryableDb): Promise<string> {
  const sessionId = getLocalSessionId();
  await db.query(buildDefineCurrentSessionParamSql(sessionId));
  return sessionId;
}

export function resetLocalSessionIdForTests(): void {
  localSessionId = null;
}

function escapeSurrealString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
