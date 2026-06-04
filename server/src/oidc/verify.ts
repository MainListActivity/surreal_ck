import { jwtVerify } from "jose";
import type { SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { getJwks } from "./jwks";

const SURREAL_EMAIL_CLAIM = "https://surrealdb.com/email";

function readEmail(payload: Record<string, unknown>): string | undefined {
  const standard = payload.email;
  if (typeof standard === "string" && standard.trim()) return standard;

  const surreal = payload[SURREAL_EMAIL_CLAIM];
  if (typeof surreal === "string" && surreal.trim()) return surreal;

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
