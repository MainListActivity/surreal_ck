import { jwtVerify } from "jose";
import type { SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { getJwks } from "./jwks";

function readEmail(payload: Record<string, unknown>): string | undefined {
  const email = payload.email;
  if (typeof email === "string" && email.trim()) return email;

  return undefined;
}

export async function verifyOidcToken(token: string): Promise<SessionUser> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
  });

  if (!payload.sub) {
    throw new Error("OIDC token is missing sub claim");
  }

  return {
    subject: payload.sub,
    email: readEmail(payload as Record<string, unknown>),
    raw: payload as Record<string, unknown>,
    rawToken: token,
  };
}
