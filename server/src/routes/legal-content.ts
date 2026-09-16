import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { ContentServiceError, type PlatformContentService } from "../content/service";

export function createLegalContentRoutes(input: Readonly<{
  service: PlatformContentService;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireUser = input.requireUser ?? requireOidc;

  return new Hono<AppBindings>().post("/api/legal/search", requireUser(), async (c) => {
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
    });
    try {
      return c.json(await input.service.searchPublishedForUser(body));
    } catch (error) {
      if (error instanceof ContentServiceError) {
        throw new HttpError(400, error.code, error.message, error.details);
      }
      throw error;
    }
  });
}
