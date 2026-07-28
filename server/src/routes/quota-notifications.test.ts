import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../app";
import type { AppBindings } from "../hono-types";
import type {
  QuotaNotificationService,
} from "../quota/quota-notifications";

const useTestUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("user", {
    subject: "admin",
    raw: {},
    rawToken: "token",
  });
  await next();
};

describe("quota notification routes", () => {
  test("passes subject allowlist and bounded limit", async () => {
    const calls: unknown[] = [];
    const notifications: QuotaNotificationService = {
      async list(input) {
        calls.push(input);
        return [];
      },
      async markRead() {
        return false;
      },
    };
    const app = createApp({
      quotaNotifications: notifications,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request("http://localhost/api/quota/notifications?limit=25"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notifications: [] });
    expect(calls).toEqual([{ actorSubject: "admin", limit: 25 }]);
  });

  test("another subject's notification is indistinguishable from missing", async () => {
    const notifications: QuotaNotificationService = {
      async list() {
        return [];
      },
      async markRead() {
        return false;
      },
    };
    const app = createApp({
      quotaNotifications: notifications,
      requireUser: () => useTestUser,
    });
    const response = await app.fetch(
      new Request(
        "http://localhost/api/quota/notifications/quota_notification_outbox%3An1/read",
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "quota-notification-not-found" },
    });
  });
});
