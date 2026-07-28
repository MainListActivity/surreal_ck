import { DateTime, StringRecordId } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import type { NativeQuotaClient } from "../db/native-quota/client";
import type {
  QuotaAuthorityReader,
  QuotaObservationSink,
} from "./quota-read-service";
import type { SweepPageHandler, SweepPageResult } from "./sweeps";

const DEFAULT_MAX_AUDIT_AGE_MS = 15 * 60_000;

type Queryable = {
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
};

function addMilliseconds(value: DateTime, milliseconds: number): DateTime {
  return DateTime.fromEpochNanoseconds(
    value.nanoseconds + BigInt(Math.round(milliseconds)) * 1_000_000n,
  );
}

function cursor(value: string | undefined): StringRecordId | undefined {
  if (!value) return undefined;
  const record = new StringRecordId(value);
  if (!record.toString().startsWith("workspace:")) {
    throw new TypeError("native audit cursor must reference workspace");
  }
  return record;
}

function workspaceRows(result: unknown): Array<{
  id: StringRecordId;
  slug: string;
}> {
  if (!Array.isArray(result)) return [];
  const statement = result[0];
  if (!Array.isArray(statement)) return [];
  return statement.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }
    const row = value as Record<string, unknown>;
    const id = toStringRecordId(row.id);
    return id && typeof row.slug === "string"
      ? [{ id, slug: row.slug }]
      : [];
  });
}

/**
 * Active workspaces are audited from native INFO even if no settings page is
 * open. The persisted sweep cursor makes a large fleet restart-safe.
 */
export class SurrealNativeAuditSweepHandler implements SweepPageHandler {
  constructor(
    private readonly db: Queryable,
    private readonly authority: QuotaAuthorityReader,
    private readonly native: NativeQuotaClient,
    private readonly observations: QuotaObservationSink,
    private readonly options: Readonly<{
      clock?: Readonly<{ now(): DateTime }>;
      maxAuditAgeMs?: number;
    }> = {},
  ) {}

  async processPage(input: Readonly<{
    cursor?: string;
    limit: number;
    fencingToken: number | bigint;
  }>): Promise<SweepPageResult> {
    const now = this.options.clock?.now() ?? DateTime.now();
    const cutoff = addMilliseconds(
      now,
      -(this.options.maxAuditAgeMs ?? DEFAULT_MAX_AUDIT_AGE_MS),
    );
    const result = await this.db.query(
      `
        SELECT id, slug
        FROM workspace
        WHERE status = "active"
          AND ($cursor = NONE OR id > $cursor)
          AND id IN (
            SELECT VALUE workspace
            FROM workspace_quota_runtime
            WHERE last_native_audit_at = NONE
              OR last_native_audit_at <= $cutoff
          )
        ORDER BY id ASC
        LIMIT $limit;
      `,
      {
        cursor: cursor(input.cursor),
        cutoff,
        limit: input.limit,
      },
    );
    const workspaces = workspaceRows(result);
    let processed = 0;
    let failed = 0;
    for (const workspace of workspaces) {
      try {
        const authority = await this.authority.findWorkspaceAuthority({
          slug: workspace.slug,
          actor: { subject: "system:native-audit" },
        });
        if (!authority) {
          failed += 1;
          continue;
        }
        const info = await this.native.info(authority.workspace.database);
        await this.observations.observe({ authority, info });
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      nextCursor: workspaces.at(-1)?.id.toString(),
      completed: workspaces.length < input.limit,
      processed,
      failed,
    };
  }
}
