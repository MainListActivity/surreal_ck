import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { StringRecordId } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import type {
  QuotaNotificationService,
} from "../quota/quota-notifications";

function limit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new HttpError(
      400,
      "quota-notification-limit-invalid",
      "limit must be an integer from 1 to 100",
    );
  }
  return parsed;
}

function notificationId(value: string): StringRecordId {
  if (!value.startsWith("quota_notification_outbox:")) {
    throw new HttpError(
      404,
      "quota-notification-not-found",
      "Notification does not exist or is not accessible",
    );
  }
  try {
    return new StringRecordId(value);
  } catch {
    throw new HttpError(
      404,
      "quota-notification-not-found",
      "Notification does not exist or is not accessible",
    );
  }
}

export function createQuotaNotificationRoutes(
  service: QuotaNotificationService,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
) {
  return new Hono<AppBindings>()
    .get("/api/quota/notifications", requireUser(), async (c) => {
      const notifications = await service.list({
        actorSubject: c.var.user.subject,
        limit: limit(c.req.query("limit")),
      });
      return c.json({ notifications });
    })
    .post(
      "/api/quota/notifications/:notificationId/read",
      requireUser(),
      async (c) => {
        const read = await service.markRead({
          notification: notificationId(c.req.param("notificationId")),
          actorSubject: c.var.user.subject,
        });
        if (!read) {
          throw new HttpError(
            404,
            "quota-notification-not-found",
            "Notification does not exist or is not accessible",
          );
        }
        return c.json({ ok: true });
      },
    );
}
