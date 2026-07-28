import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import { SurrealQuotaIntentStatusReader } from "./quota-intent-status";

describe("SurrealQuotaIntentStatusReader", () => {
  test("creator can read status without gaining access to another intent", async () => {
    const reader = new SurrealQuotaIntentStatusReader({
      db: {
        async query(sql) {
          if (sql.startsWith("SELECT intent_kind")) {
            return [[{
              intent_kind: "override_schedule",
              actor_subject: "creator",
            }]];
          }
          if (sql.includes("quota_operator_intent_state")) {
            return [[{
              state: "pending",
              attempt_count: 0,
              affected_workspaces: ["workspace:demo"],
              updated_at: "2026-07-28T00:00:00.000Z",
            }]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });
    await expect(reader.get({
      intent: new StringRecordId("quota_operator_intent:req"),
      actorSubject: "creator",
    })).resolves.toEqual({
      format_version: 1,
      id: "quota_operator_intent:req",
      kind: "override_schedule",
      state: "pending",
      attempt_count: 0,
      next_attempt_at: null,
      processed_at: null,
      last_error_code: null,
      affected_workspaces: ["workspace:demo"],
      updated_at: "2026-07-28T00:00:00.000Z",
    });
  });

  test("non-creator needs active quota.read capability", async () => {
    let stateQueried = false;
    const reader = new SurrealQuotaIntentStatusReader({
      db: {
        async query(sql) {
          if (sql.startsWith("SELECT intent_kind")) {
            return [[{
              intent_kind: "override_schedule",
              actor_subject: "creator",
            }]];
          }
          if (sql.includes("platform_operator_capability")) return [[]];
          if (sql.includes("quota_operator_intent_state")) stateQueried = true;
          return [[]];
        },
      },
    });
    await expect(reader.get({
      intent: new StringRecordId("quota_operator_intent:req"),
      actorSubject: "stranger",
    })).resolves.toBeNull();
    expect(stateQueried).toBe(false);
  });
});
