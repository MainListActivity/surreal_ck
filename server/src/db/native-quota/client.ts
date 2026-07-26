import {
  NativeQuotaInfoSchema,
  NativeQuotaOperationResultSchema,
  type NativeQuotaOperationResult,
  type NativeQuotaInfo,
  type NativeQuotaRule,
} from "@surreal-ck/shared/native-quota";
import { jsonify } from "surrealdb";

export type NativeQuotaQueryClient = {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T>;
};

export interface NativeQuotaClient {
  info(database: string): Promise<NativeQuotaInfo>;
  applyPolicy(input: NativeQuotaPolicyApplyInput): Promise<NativeQuotaOperationResult>;
  rebuild(database: string): Promise<NativeQuotaOperationResult>;
}

const DATABASE_IDENTIFIER = /^(?:_system|ws_[a-z0-9_]+)$/;
const UNSIGNED_MAX = 18_446_744_073_709_551_615n;

export type NativeQuotaPolicyApplyInput = Readonly<{
  database: string;
  rules: readonly NativeQuotaRule[];
  expectedGeneration?: number | bigint;
}>;

function assertDatabaseIdentifier(database: string): void {
  if (!DATABASE_IDENTIFIER.test(database)) {
    throw new Error(`Invalid native quota database identifier: ${database}`);
  }
}

function firstStatementResult(result: unknown): unknown {
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("Native quota INFO returned an unexpected statement result");
  }
  return result[0];
}

function unsignedLiteral(
  value: number | bigint,
  field: "generation" | "limit",
): string {
  if (
    !(
      typeof value === "bigint"
      || (typeof value === "number" && Number.isSafeInteger(value))
    )
  ) {
    throw new TypeError(`${field} must be a safe integer or bigint`);
  }
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > UNSIGNED_MAX) {
    throw new RangeError(`${field} is outside the native unsigned integer range`);
  }
  return normalized.toString();
}

function escapeIdentifier(value: string): string {
  if (value.length === 0) throw new TypeError("quota identifier cannot be empty");
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("\0", "\\0")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\b", "\\u{8}")
    .replaceAll("\f", "\\f");
  return `\`${escaped}\``;
}

function regexLiteral(pattern: string): string {
  const escaped = pattern
    .replaceAll("/", "\\/")
    .replaceAll("\0", "\\x00")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  return `/${escaped}/`;
}

function serializeRule(rule: NativeQuotaRule): string {
  const selector = rule.selector.kind === "exact"
    ? `EXACT ${escapeIdentifier(rule.selector.table)}`
    : `REGEX ${regexLiteral(rule.selector.pattern)}`;
  const limit = rule.limit.kind === "unlimited"
    ? "UNLIMITED"
    : unsignedLiteral(rule.limit.value, "limit");
  return [
    "RULE",
    escapeIdentifier(rule.rule_id),
    "FOR",
    rule.resource.toUpperCase(),
    "MATCH",
    selector,
    "LIMIT",
    limit,
  ].join(" ");
}

/**
 * SurrealQL quota grammar 的唯一应用侧适配器。上层只依赖 NativeQuotaClient
 * 与 shared DTO，不拼接或解析 quota 语句。
 */
export class SurrealNativeQuotaClient implements NativeQuotaClient {
  constructor(private readonly db: NativeQuotaQueryClient) {}

  async info(database: string): Promise<NativeQuotaInfo> {
    assertDatabaseIdentifier(database);
    const result = await this.db.query(
      `INFO FOR QUOTA ON DATABASE ${database} STRUCTURE;`,
    );
    return NativeQuotaInfoSchema.parse(jsonify(firstStatementResult(result)));
  }

  async applyPolicy(
    input: NativeQuotaPolicyApplyInput,
  ): Promise<NativeQuotaOperationResult> {
    assertDatabaseIdentifier(input.database);
    if (input.rules.length === 0) {
      throw new TypeError("native quota policy must contain at least one rule");
    }
    const mode = input.expectedGeneration === undefined
      ? "DEFINE QUOTA"
      : `DEFINE QUOTA OVERWRITE`;
    const guard = input.expectedGeneration === undefined
      ? ""
      : ` EXPECT GENERATION ${unsignedLiteral(input.expectedGeneration, "generation")}`;
    const rules = input.rules.map(serializeRule).join(" ");
    const result = await this.db.query(
      `${mode} ON DATABASE ${input.database}${guard} ${rules};`,
    );
    return NativeQuotaOperationResultSchema.parse(
      jsonify(firstStatementResult(result)),
    );
  }

  async rebuild(database: string): Promise<NativeQuotaOperationResult> {
    assertDatabaseIdentifier(database);
    const result = await this.db.query(
      `REBUILD QUOTA IF NEEDED ON DATABASE ${database};`,
    );
    return NativeQuotaOperationResultSchema.parse(
      jsonify(firstStatementResult(result)),
    );
  }
}
