import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Surreal } from "surrealdb";

const AUTH_DOC_PATH = join(import.meta.dir, "../../../.idea/surrealdb-auth.md");
const REMOTE_URL =
  process.env.SURREALDB_URL ??
  "wss://cuckoox-06efnpc64psu927c5555v64q5g.aws-usw2.surreal.cloud";
const EXPECTED_NAMESPACE = process.env.SURREALDB_NS ?? "main";
const EXPECTED_DATABASE = process.env.SURREALDB_DB ?? "docs";
const EXPECTED_ACCESS = process.env.SURREALDB_ACCESS ?? "madocs";

type JwtPayload = {
  exp?: number;
  "https://surrealdb.com/ns"?: string;
  "https://surrealdb.com/db"?: string;
  "https://surrealdb.com/ac"?: string;
};

function readDocumentedAccessToken(): string | null {
  if (!existsSync(AUTH_DOC_PATH)) return null;

  const markdown = readFileSync(AUTH_DOC_PATH, "utf8");
  return (
    markdown.match(/`(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`/)?.[1] ??
    null
  );
}

function decodeJwtPayload(token: string): JwtPayload {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("JWT payload is missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
}

const documentedAccessToken = readDocumentedAccessToken();
const documentedTokenPayload = documentedAccessToken
  ? decodeJwtPayload(documentedAccessToken)
  : null;
const tokenIsUsable =
  typeof documentedTokenPayload?.exp === "number" &&
  documentedTokenPayload.exp > Math.floor(Date.now() / 1000);
const remoteAuthTest =
  documentedAccessToken && tokenIsUsable ? test : test.skip;

describe("SurrealDB 远端 Auth0/OIDC accessToken", () => {
  const documentedTokenTest = documentedAccessToken ? test : test.skip;

  documentedTokenTest("文档里的 accessToken 包含 SurrealDB 认证 claims", () => {
    expect(documentedTokenPayload?.["https://surrealdb.com/ns"]).toBe(
      EXPECTED_NAMESPACE
    );
    expect(documentedTokenPayload?.["https://surrealdb.com/db"]).toBe(
      EXPECTED_DATABASE
    );
    expect(documentedTokenPayload?.["https://surrealdb.com/ac"]).toBe(
      EXPECTED_ACCESS
    );
  });

  remoteAuthTest(
    "文档里的 accessToken 可以登录 SurrealDB Cloud",
    async () => {
      if (!documentedAccessToken) {
        throw new Error(`No accessToken found in ${AUTH_DOC_PATH}`);
      }

      const db = new Surreal();
      let authenticated = false;

      try {
        await db.connect(REMOTE_URL);
        await db.use({
          namespace: EXPECTED_NAMESPACE,
          database: EXPECTED_DATABASE,
        });
        await db.authenticate(documentedAccessToken);
        authenticated = true;
      } finally {
        await db.close().catch(() => undefined);
      }

      expect(authenticated).toBe(true);
    },
    15_000
  );
});
