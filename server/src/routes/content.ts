import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import {
  ContentServiceError,
  PlatformContentService,
  type ContentOperator,
} from "../content/service";

function serviceError(error: ContentServiceError): HttpError {
  const status = error.code === "forged_actor" || error.code === "source_not_authorized"
    ? 403
    : error.code === "identity_ambiguous"
      ? 404
      : error.code === "idempotency_conflict" || error.code === "stale_version" || error.code === "validation_stale"
        ? 409
        : error.code === "publish_failed"
          ? 503
          : 400;
  return new HttpError(status, error.code, error.message, error.details);
}

async function jsonBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new HttpError(400, "invalid_request", "请求体必须是合法 JSON");
  }
}

export function createContentRoutes(input: Readonly<{
  service: PlatformContentService;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireUser = input.requireUser ?? (() => requirePlatformOperator());
  const actor = (c: { var: AppBindings["Variables"] }): ContentOperator => {
    const operator = c.var.platformOperator;
    if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
    return { subject: operator.subject, capabilities: operator.capabilities };
  };
  const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ContentServiceError) throw serviceError(error);
      throw error;
    }
  };

  return new Hono<AppBindings>()
    .get("/api/content/contract", requireUser(), async (c) => c.json(await run(() => input.service.getDataContract(actor(c), {
      contractVersion: c.req.query("contractVersion") ?? null,
    }))))
    .post("/api/content/batches", requireUser(), async (c) => {
      const body = await jsonBody(c);
      return c.json(await run(() => input.service.submitBatch(actor(c), body)));
    })
    .get("/api/content/batches/:batchId", requireUser(), async (c) => c.json(await run(() => input.service.inspectBatchResponse(actor(c), {
      batchId: c.req.param("batchId"),
      cursor: c.req.query("cursor") ?? null,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 20,
    }))))
    .post("/api/content/publications", requireUser(), async (c) => {
      const body = await jsonBody(c);
      return c.json(await run(() => input.service.publishBatch(actor(c), body)));
    })
    .post("/api/content/search", requireUser(), async (c) => {
      const body = await jsonBody(c);
      return c.json(await run(() => input.service.searchContent(actor(c), body)));
    });
}
