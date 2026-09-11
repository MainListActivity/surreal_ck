import { jwtVerify } from "jose";
import type { SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { getJwks } from "./jwks";

export type VerifyOidcTokenOptions = Readonly<{
  /** 运营端 / MCP 传入独立 resource audience；客户 API 仍使用 env.OIDC_AUDIENCE。 */
  audience?: string | string[];
}>;

function readEmail(payload: Record<string, unknown>): string | undefined {
  const email = payload.email;
  if (typeof email === "string" && email.trim()) return email;

  return undefined;
}

export async function verifyOidcToken(
  token: string,
  options: VerifyOidcTokenOptions = {},
): Promise<SessionUser> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: env.OIDC_ISSUER,
    audience: options.audience ?? env.OIDC_AUDIENCE,
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
