import {
  NativeQuotaInfoSchema,
  type NativeQuotaInfo,
} from "@surreal-ck/shared/native-quota";
import { jsonify } from "surrealdb";

export type NativeQuotaQueryClient = {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T>;
};

export interface NativeQuotaClient {
  info(database: string): Promise<NativeQuotaInfo>;
}

const DATABASE_IDENTIFIER = /^(?:_system|ws_[a-z0-9_]+)$/;

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
}

