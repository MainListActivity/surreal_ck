import { getLocalDb } from "../db/index";
import { ServiceError } from "../services/errors";

const EXEC_TEMPLATE_URL = "https://auth.maplayer.top/api/db/execTemplate";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const EXEC_TEMPLATE_IDS = {
  entityTable: "ddl-entity-table",
  relationTable: "ddl-relation-table",
  entityFieldAdd: "ddl-entity-field-add",
  entityFieldOverwrite: "ddl-entity-field-overwrite",
  entityFieldRemove: "ddl-entity-field-remove",
} as const;

export type ExecTemplateDeps = {
  accessToken?: () => Promise<string>;
  fetch?: FetchLike;
};

export async function execTemplate(
  id: string,
  params: Record<string, unknown>,
  deps: ExecTemplateDeps = {},
): Promise<void> {
  const accessToken = deps.accessToken ?? readAccessTokenFromLocalDb;
  const fetchImpl = deps.fetch ?? fetch;
  const token = await accessToken();

  let response: Response;
  try {
    response = await fetchImpl(EXEC_TEMPLATE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id, params }),
    });
  } catch (err) {
    throw new ServiceError("OFFLINE_DDL_FORBIDDEN", err instanceof Error ? err.message : String(err));
  }

  if (response.ok) return;

  const message = (await response.text().catch(() => "")).trim();
  if (response.status >= 400 && response.status < 500) {
    throw new ServiceError("TEMPLATE_REJECTED", message || `template rejected: ${id}`);
  }
  throw new ServiceError("REMOTE_DDL_FAILED", message || `remote DDL failed: ${id}`);
}

async function readAccessTokenFromLocalDb(): Promise<string> {
  const db = getLocalDb();
  const rows = await db.query<[{ access_token?: string }[]]>(
    `SELECT access_token FROM token_store:local LIMIT 1`,
  );
  const token = rows[0]?.[0]?.access_token;
  if (!token) throw new ServiceError("NOT_AUTHENTICATED");
  return token;
}
