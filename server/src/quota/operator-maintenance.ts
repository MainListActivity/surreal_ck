import { StringRecordId } from "surrealdb";
import type { NativeQuotaClient } from "../db/native-quota/client";
import type {
  QuotaAuthorityReader,
  QuotaObservationSink,
} from "./quota-read-service";
import {
  QuotaLifecycleError,
  type QuotaOperatorMaintenancePort,
} from "./subscription-lifecycle";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

function firstString(result: unknown): string | null {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return null;
  const value = result[0][0];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Executes the root-only native maintenance step behind an already audited
 * operator intent. The browser never receives the root connection or native
 * REBUILD statement; successful completion is always followed by INFO
 * readback and the normal observation/alert pipeline.
 */
export class SurrealQuotaOperatorMaintenance
  implements QuotaOperatorMaintenancePort {
  constructor(
    private readonly db: Queryable,
    private readonly authority: QuotaAuthorityReader,
    private readonly native: NativeQuotaClient,
    private readonly observations: QuotaObservationSink,
  ) {}

  async rebuildLedger(input: Readonly<{
    workspace: StringRecordId;
    actorSubject: string;
  }>): Promise<void> {
    const slug = firstString(await this.db.query(
      "SELECT VALUE slug FROM ONLY $workspace;",
      { workspace: input.workspace },
    ));
    if (!slug) {
      throw new QuotaLifecycleError(
        "operator_ledger_workspace_missing",
        "ledger rebuild workspace does not exist",
      );
    }
    const authority = await this.authority.findWorkspaceAuthority({
      slug,
      actor: { subject: input.actorSubject },
    });
    if (
      !authority
      || authority.workspace.record !== input.workspace.toString()
    ) {
      throw new QuotaLifecycleError(
        "operator_ledger_workspace_unavailable",
        "ledger rebuild workspace is no longer accessible",
      );
    }
    await this.native.rebuild(authority.workspace.database);
    const info = await this.native.info(authority.workspace.database);
    await this.observations.observe({ authority, info });
  }
}
