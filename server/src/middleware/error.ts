import { publicEntry, publicRateLimited } from "@surreal-ck/shared/public-entry";
import type { ErrorHandler } from "hono";
import type { ApiError } from "@surreal-ck/shared";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";

export const handleError: ErrorHandler<AppBindings> = (err, c) => {
  const isHttpError = err instanceof HttpError;
  const status = isHttpError ? err.status : 500;
  const code = isHttpError ? err.code : "internal";
  const message = isHttpError ? err.message : "Internal server error";

  console.error("[http] unhandled error", {
    method: c.req.method,
    path: c.req.path.replace(/^\/api\/claims-portal\/([^/]+)\/[^/]+/u, "/api/claims-portal/$1/[redacted]"),
    status,
    code,
    stack: err instanceof Error ? err.stack : undefined,
  });

  if (status === 429 && publicEntry(c.req.path)) return publicRateLimited();

  const body: ApiError = {
    error: {
      code,
      message,
      ...(isHttpError && err.details !== undefined ? { details: err.details } : {}),
    },
  };

  return c.json(body, status as never);
};
