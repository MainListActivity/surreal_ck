import { DateTime, StringRecordId } from "surrealdb";
import { toStringRecordId } from "../db/surreal-values";
import type { EntitlementRefreshPort } from "./subscription-lifecycle";
import type { SweepPageHandler, SweepPageResult } from "./sweeps";

export type LifecycleBoundaryQueryClient = Readonly<{
  query<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}>;

function dueWorkspaceIds(result: unknown): StringRecordId[] {
  const statements = Array.isArray(result) ? result : [];
  const rows = [...statements].reverse().find((statement) =>
    Array.isArray(statement)
    && statement.some((row) =>
      typeof row === "object"
      && row !== null
      && !Array.isArray(row)
      && "id" in row
    )
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return undefined;
      }
      return toStringRecordId((row as Record<string, unknown>).id) ?? undefined;
    })
    .filter((workspace): workspace is StringRecordId =>
      workspace !== undefined
    );
}

function workspaceCursor(cursor: string | undefined): StringRecordId | undefined {
  if (!cursor) return undefined;
  const parsed = new StringRecordId(cursor);
  if (!parsed.toString().startsWith("workspace:")) {
    throw new TypeError("lifecycle sweep cursor must reference workspace");
  }
  return parsed;
}

/**
 * Finds time boundaries that do not require another provider webhook:
 * trial/cancel/paid/grace/source/item/override expiry. Each due workspace is
 * resolved again; the resolver decides whether the result is standard, grace,
 * retention, or unchanged.
 */
export class SurrealLifecycleBoundarySweepHandler
  implements SweepPageHandler
{
  constructor(
    private readonly db: LifecycleBoundaryQueryClient,
    private readonly refresher: EntitlementRefreshPort,
    private readonly clock: Readonly<{ now(): DateTime }> = {
      now: () => DateTime.now(),
    },
  ) {}

  async processPage(input: {
    cursor?: string;
    limit: number;
    fencingToken: number | bigint;
  }): Promise<SweepPageResult> {
    const now = this.clock.now();
    const result = await this.db.query(
      `
        LET $dueSubscriptions = SELECT VALUE id
          FROM quota_subscription
          WHERE (
            status = "trialing"
            AND trial_end != NONE
            AND trial_end <= $now
          ) OR (
            status = "past_due"
            AND grace_until != NONE
            AND grace_until <= $now
          ) OR (
            status INSIDE ["paused", "canceled", "expired"]
            AND (
              (paid_through != NONE AND paid_through <= $now)
              OR (
                paid_through = NONE
                AND current_period_end != NONE
                AND current_period_end <= $now
              )
              OR (
                paid_through = NONE
                AND current_period_end = NONE
                AND cancel_at != NONE
                AND cancel_at <= $now
              )
              OR (
                paid_through = NONE
                AND current_period_end = NONE
                AND cancel_at = NONE
                AND expires_at != NONE
                AND expires_at <= $now
              )
              OR (
                paid_through = NONE
                AND current_period_end = NONE
                AND cancel_at = NONE
                AND expires_at = NONE
                AND canceled_at != NONE
                AND canceled_at <= $now
              )
            )
          ) OR (
            status = "active"
            AND (
              (cancel_at != NONE AND cancel_at <= $now)
              OR (expires_at != NONE AND expires_at <= $now)
              OR (
                cancel_at_period_end = true
                AND current_period_end != NONE
                AND current_period_end <= $now
              )
            )
          );
        LET $dueItemIds = SELECT VALUE id
          FROM quota_subscription_item
          WHERE status = "active"
            AND (
              subscription IN $dueSubscriptions
              OR (
                effective_until != NONE
                AND effective_until <= $now
              )
            );
        LET $dueItemWorkspaces = SELECT VALUE workspace
          FROM quota_subscription_item
          WHERE id IN $dueItemIds;
        LET $dueOverrideIds = SELECT VALUE id
          FROM quota_override_revision
          WHERE expires_at != NONE AND expires_at <= $now;
        LET $dueOverrideWorkspaces = SELECT VALUE workspace
          FROM workspace_quota_override
          WHERE active_revision IN $dueOverrideIds;
        SELECT id
          FROM workspace
          WHERE ($cursor = NONE OR id > $cursor)
            AND (
              (
                id IN $dueItemWorkspaces
                AND (
                  desired_entitlement = NONE
                  OR desired_entitlement IN (
                    SELECT VALUE id
                    FROM resource_entitlement
                    WHERE subscription_item IN $dueItemIds
                  )
                )
              )
              OR (
                id IN $dueOverrideWorkspaces
                AND (
                  desired_entitlement = NONE
                  OR desired_entitlement IN (
                    SELECT VALUE id
                    FROM resource_entitlement
                    WHERE override_revision IN $dueOverrideIds
                  )
                )
              )
            )
          ORDER BY id ASC
          LIMIT $limit;
      `,
      {
        now,
        cursor: workspaceCursor(input.cursor),
        limit: input.limit,
      },
    );
    const workspaces = dueWorkspaceIds(result);
    let processed = 0;
    let failed = 0;
    for (const workspace of workspaces) {
      try {
        await this.refresher.refreshWorkspace({
          workspace,
          at: now,
          operationKind: "source_expiry",
          actorKind: "system",
          correlationId:
            `quota-boundary:${input.fencingToken.toString()}:${workspace.toString()}`,
          causationId:
            `control-plane-sweep:${input.fencingToken.toString()}:${workspace.toString()}:${now.toString()}`,
        });
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    const last = workspaces.at(-1);
    return Object.freeze({
      nextCursor: last?.toString(),
      completed: workspaces.length < input.limit,
      processed,
      failed,
    });
  }
}
