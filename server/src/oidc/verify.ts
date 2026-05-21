import { jwtVerify } from "jose";
import type { SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { jwks } from "./jwks";

export async function verifyOidcToken(token: string): Promise<SessionUser> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
  });

  if (!payload.sub) {
    throw new Error("OIDC token is missing sub claim");
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    raw: payload as Record<string, unknown>,
    rawToken: token,
  };
}
