import { describe, expect, test } from "bun:test";
import { StringRecordId } from "surrealdb";
import { SurrealQuotaNotificationService } from "./quota-notifications";

describe("SurrealQuotaNotificationService", () => {
  test("lists only recipient-bound allowlist fields", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const service = new SurrealQuotaNotificationService({
      db: {
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FROM quota_notification_outbox")) {
            return [[{
              id: "quota_notification_outbox:n1",
              workspace: {
                id: "workspace:demo",
                slug: "demo",
                name: "Demo",
                db_name: "must-not-leak",
              },
              payload: {
                format_version: 1,
                kind: "threshold",
                threshold_percent: 90,
                resource_key: "record/ent",
                label: "实体记录",
                table_identity: "ent_case",
                used: 90,
                limit: 100,
                internal_digest: "must-not-leak",
              },
              created_at: "2026-07-28T00:00:00.000Z",
            }]];
          }
          if (sql.includes("quota_notification_delivery")) {
            return [[{
              notification: "quota_notification_outbox:n1",
              read_at: "2026-07-28T00:01:00.000Z",
            }]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await service.list({
      actorSubject: "admin",
      limit: 20,
    });
    expect(result).toEqual([{
      id: "quota_notification_outbox:n1",
      workspace: {
        id: "workspace:demo",
        slug: "demo",
        name: "Demo",
      },
      kind: "threshold",
      threshold_percent: 90,
      resource_key: "record/ent",
      label: "实体记录",
      table: "ent_case",
      used: 90,
      limit: 100,
      created_at: "2026-07-28T00:00:00.000Z",
      read_at: "2026-07-28T00:01:00.000Z",
    }]);
    const outboxQuery = calls[0];
    expect(outboxQuery?.sql).toContain("recipient_subject = $subject");
    expect(outboxQuery?.params).toMatchObject({
      subject: "admin",
      limit: 20,
    });
  });

  test("mark-read binds both notification id and actor subject", async () => {
    let params: Record<string, unknown> | undefined;
    const service = new SurrealQuotaNotificationService({
      db: {
        async query(_sql, input) {
          params = input;
          return [null, [], true];
        },
      },
    });
    await expect(service.markRead({
      notification: new StringRecordId("quota_notification_outbox:n1"),
      actorSubject: "admin",
    })).resolves.toBe(true);
    expect(String(params?.notification)).toBe("quota_notification_outbox:n1");
    expect(params?.subject).toBe("admin");
  });
});
