import { createHash } from "node:crypto";
import {
  PLATFORM_OPERATORS_FORMAT_VERSION,
  type PlatformOperatorCapability,
  type PlatformOperatorsView,
  type PlatformOperatorSubjectView,
} from "@surreal-ck/shared/native-quota";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};
type RootSessionFactory = (database: string, namespace?: string) => Promise<Queryable>;

type Row = Record<string, unknown>;

function statementRows(value: unknown, index: number): Row[] {
  if (!Array.isArray(value)) return [];
  const statement = value[index];
  if (!Array.isArray(statement)) return [];
  return statement.filter((item): item is Row =>
    typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

/** 主体的伪名标识：确定性 sha256 前缀，可对齐、不可逆、不含原始 subject。 */
export function platformOperatorSubjectHash(subject: string): string {
  const digest = createHash("sha256").update(subject).digest("hex");
  return `sha256:${digest.slice(0, 12)}`;
}

export type PlatformOperatorKind = "human" | "agent";
export type PlatformOperatorStatus = "active" | "disabled";

/** 一次读取得到的运营主体快照；subject 仍是原始值，只在内存里用。 */
export type PlatformOperatorSnapshotEntry = Readonly<{
  subject: string;
  kind: PlatformOperatorKind | null;
  status: PlatformOperatorStatus;
  capabilities: readonly string[];
}>;

/** 只读端口：没有任何写方法，便于测试与拒写约束的断言。 */
export type PlatformOperatorListPort = Readonly<{
  list(): Promise<readonly PlatformOperatorSnapshotEntry[]>;
}>;

function kindOf(value: unknown): PlatformOperatorKind | null {
  return value === "human" || value === "agent" ? value : null;
}

function statusOf(value: unknown): PlatformOperatorStatus {
  return value === "disabled" ? "disabled" : "active";
}

function capabilityOf(value: unknown): PlatformOperatorCapability | null {
  return typeof value === "string" && value.length > 0
    ? value as PlatformOperatorCapability
    : null;
}

/**
 * 把一次快照投影成接口视图：做主体哈希、能力排序与 isCurrent 标记。
 * 纯函数，不碰数据库，也不回传任何 PII。
 */
export function toPlatformOperatorsView(
  entries: readonly PlatformOperatorSnapshotEntry[],
  currentSubject: string,
): PlatformOperatorsView {
  const operators: PlatformOperatorSubjectView[] = entries.map((entry) => ({
    subject_hash: platformOperatorSubjectHash(entry.subject),
    kind: entry.kind,
    status: entry.status,
    capabilities: [...entry.capabilities].sort() as PlatformOperatorCapability[],
    isCurrent: entry.subject === currentSubject,
  }));
  return { format_version: PLATFORM_OPERATORS_FORMAT_VERSION, operators };
}

/**
 * `_system` 里的运营主体与能力只读视图。
 *
 * 两条语句都只是 SELECT；能力按主体聚合、按字母序输出，保证同一状态下响应稳定。
 */
export class SurrealPlatformOperatorList implements PlatformOperatorListPort {
  constructor(
    private readonly getSession: RootSessionFactory = getRootDatabaseSession,
    private readonly namespace: string = env.SURREAL_NS,
  ) {}

  async list(): Promise<readonly PlatformOperatorSnapshotEntry[]> {
    const db = await this.getSession("_system", this.namespace);
    const result = await db.query(`
      SELECT id, subject, kind, status, created_at FROM platform_operator
        ORDER BY created_at ASC, subject ASC;
      SELECT operator, capability FROM platform_operator_capability WHERE status = "active";
    `);
    const operatorRows = statementRows(result, 0);
    const capabilityRows = statementRows(result, 1);

    const capabilitiesByOperator = new Map<string, string[]>();
    for (const row of capabilityRows) {
      const operator = toStringRecordId(row.operator)?.toString();
      const capability = capabilityOf(row.capability);
      if (!operator || !capability) continue;
      const bucket = capabilitiesByOperator.get(operator) ?? [];
      if (!bucket.includes(capability)) bucket.push(capability);
      capabilitiesByOperator.set(operator, bucket);
    }

    const entries: PlatformOperatorSnapshotEntry[] = [];
    for (const row of operatorRows) {
      const subject = typeof row.subject === "string" ? row.subject : "";
      if (subject === "") continue;
      const id = toStringRecordId(row.id)?.toString() ?? "";
      entries.push({
        subject,
        kind: kindOf(row.kind),
        status: statusOf(row.status),
        capabilities: capabilitiesByOperator.get(id) ?? [],
      });
    }
    return entries;
  }
}
