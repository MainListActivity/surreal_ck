import { SYNC_SCOPE } from "./scope";

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

export function buildDefineLocalOriginSessionSql(): string {
  return SYNC_SCOPE
    .map(({ table }) => `DEFINE FIELD OVERWRITE _origin_session_id ON TABLE ${table} TYPE option<string>
  DEFAULT ALWAYS ($current_session_id ?? NONE);
REMOVE EVENT IF EXISTS ${table}_origin_session ON TABLE ${table};`)
    .join("\n");
}

export async function defineCurrentSessionParam(db: QueryableDb): Promise<string> {
  const sessionId = getLocalSessionId();
  await db.query(buildDefineCurrentSessionParamSql(sessionId));
  return sessionId;
}

export async function defineLocalOriginSessionFields(db: QueryableDb): Promise<void> {
  await db.query(buildDefineLocalOriginSessionSql());
}

export function resetLocalSessionIdForTests(): void {
  localSessionId = null;
}

function escapeSurrealString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
