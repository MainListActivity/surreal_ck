import type { MiddlewareHandler } from "hono";
import { env } from "../env";
import { HttpError } from "../http-error";

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}

export function requireInternalHook(): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token || !constantTimeEqual(token, env.IDP_HOOK_SECRET)) {
      throw new HttpError(401, "internal-hook-auth-invalid", "Invalid internal hook credentials");
    }

    await next();
  };
}
