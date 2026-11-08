// 测试主体（test_subject）读面：判断某个 subject 是否登记为测试账号、是否已到期。
// 写面由 ops-test-subjects 路由与 seed 使用；reaper 只依赖这里的查询。

export type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export interface TestSubjectRow {
  id: unknown;
  subject: string;
  email: string | null;
  expires_at: string;
  origin: string | null;
}

function rows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as Record<string, unknown>[];
}

export async function findTestSubject(
  db: Queryable,
  subject: string,
): Promise<TestSubjectRow | null> {
  const result = await db.query(
    `SELECT id, subject, email, expires_at, origin FROM test_subject WHERE subject = $subject LIMIT 1;`,
    { subject },
  );
  const row = rows(result)[0];
  return row === undefined ? null : (row as unknown as TestSubjectRow);
}

export function isExpired(row: Pick<TestSubjectRow, "expires_at">, now: Date): boolean {
  return Date.parse(row.expires_at) <= now.getTime();
}

/** subject 是登记在案的测试主体且尚未到期。 */
export async function isActiveTestSubject(
  db: Queryable,
  subject: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await findTestSubject(db, subject);
  return row !== null && !isExpired(row, now);
}

/** subject 是已到期的测试主体（未登记的返回 false）。 */
export async function isExpiredTestSubject(
  db: Queryable,
  subject: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await findTestSubject(db, subject);
  return row !== null && isExpired(row, now);
}
