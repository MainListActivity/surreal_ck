import {
  loadTemplateScripts as loadTemplateScriptsDefault,
  type WorkspaceTemplateScript,
} from "@surreal-ck/shared/workspace-template";
import {
  loadTemplatePackScripts as loadTemplatePackScriptsDefault,
  type TemplatePackScript,
} from "@surreal-ck/shared/template-packs";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import { createIdpTokenScopeAdapter } from "./idp-scope-adapter";

export type CreateWorkspaceClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type CreateWorkspaceSessionFactory = (database: string, namespace: string) => Promise<CreateWorkspaceClient>;

export type CreateWorkspaceInput = {
  subject: string;
  subjectToken: string;
  email: string;
  name: string;
  slug: string;
};

export type CreateWorkspaceResult =
  | {
      kind: "created";
      slug: string;
      dbName: string;
      accessToken: string;
      expiresIn: number | null;
    }
  | {
      kind: "slug-conflict";
    }
  | {
      kind: "scope-update-failed";
      slug: string;
      dbName: string;
    };

export interface WorkspaceCreator {
  createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult>;
}

export type CreateWorkspaceCreatorOptions = {
  getDbSession?: CreateWorkspaceSessionFactory;
  idpTokenScopeAdapter?: IdpTokenScopeAdapter;
  loadTemplateScripts?: () => Promise<WorkspaceTemplateScript[]>;
  loadTemplatePackScripts?: () => Promise<TemplatePackScript[]>;
  generateId?: () => string;
  namespace?: string;
};

const SYSTEM_DATABASE = "_system";
const MAX_DB_NAME_ATTEMPTS = 5;

function defaultGenerateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function defaultGetDbSession(database: string, namespace: string): Promise<CreateWorkspaceClient> {
  return getRootDatabaseSession(database, namespace);
}

export function createWorkspaceCreator(options: CreateWorkspaceCreatorOptions = {}): WorkspaceCreator {
  const idpTokenScopeAdapter = options.idpTokenScopeAdapter ?? createIdpTokenScopeAdapter();
  const loadScripts = options.loadTemplateScripts ?? (() => loadTemplateScriptsDefault({ oidcJwksUrl: env.OIDC_JWKS_URL }));
  const loadPackScripts =
    options.loadTemplatePackScripts ??
    (() => loadTemplatePackScriptsDefault({ selectedPacks: env.WORKSPACE_TEMPLATE_PACKS }));
  const generateId = options.generateId ?? defaultGenerateId;
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession ?? defaultGetDbSession;

  return {
    async createWorkspace(input) {
      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);

      // slug 唯一性预检：命中即 409，不建库。
      const slugResult = await systemDb.query("SELECT id FROM workspace WHERE slug = $slug LIMIT 1;", {
        slug: input.slug,
      });
      if (rowCount(slugResult) > 0) {
        return { kind: "slug-conflict" };
      }

      for (let attempt = 0; attempt < MAX_DB_NAME_ATTEMPTS; attempt += 1) {
        const dbName = makeWorkspaceDbName(generateId());
        const result = await tryCreateWorkspace({
          systemDb,
          getDbSession,
          namespace,
          input,
          dbName,
          loadScripts,
          loadPackScripts,
          idpTokenScopeAdapter,
        });

        if (result.kind !== "db-name-conflict") {
          return result;
        }
      }

      throw new Error(`workspace db_name allocation failed after ${MAX_DB_NAME_ATTEMPTS} attempts`);
    },
  };
}

function rowCount(result: unknown): number {
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) ? rows.length : 0;
}

function makeWorkspaceDbName(id: string): string {
  const dbName = `ws_${id}`;
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error("generated workspace db name is invalid");
  }
  return dbName;
}

type TryCreateWorkspaceInput = {
  systemDb: CreateWorkspaceClient;
  getDbSession: CreateWorkspaceSessionFactory;
  namespace: string;
  input: CreateWorkspaceInput;
  dbName: string;
  loadScripts: () => Promise<WorkspaceTemplateScript[]>;
  loadPackScripts: () => Promise<TemplatePackScript[]>;
  idpTokenScopeAdapter: IdpTokenScopeAdapter;
};

type TryCreateWorkspaceResult = CreateWorkspaceResult | { kind: "db-name-conflict" };

async function tryCreateWorkspace({
  systemDb,
  getDbSession,
  namespace,
  input,
  dbName,
  loadScripts,
  loadPackScripts,
  idpTokenScopeAdapter,
}: TryCreateWorkspaceInput): Promise<TryCreateWorkspaceResult> {
  let createdDatabase = false;

  try {
    await systemDb.query(`DEFINE DATABASE ${dbName};`);
    createdDatabase = true;
  } catch (cause) {
    if (isDbNameConflict(cause)) {
      return { kind: "db-name-conflict" };
    }
    throw new Error(`workspace database create failed for ${dbName}`, { cause });
  }

  try {
    const workspaceDb = await getDbSession(dbName, namespace);
    const scripts = await loadScripts();
    for (const script of scripts) {
      await workspaceDb.query(script.sql);
    }

    const packScripts = await loadPackScripts();
    for (const script of packScripts) {
      await workspaceDb.query(script.sql);
    }

    const latestVersion = scripts.at(-1)?.version;
    if (latestVersion !== undefined) {
      await workspaceDb.query("UPSERT schema_version:current CONTENT { version: $version, applied_at: time::now() };", {
        version: latestVersion,
      });
    }

    await workspaceDb.query(
      `INSERT INTO user {
         subject: $subject,
         email: $email,
         display_name: $displayName,
         kind: "human",
         is_admin: true,
         last_seen_at: time::now()
       }
       ON DUPLICATE KEY UPDATE is_admin = true, last_seen_at = time::now();`,
      { subject: input.subject, email: input.email, displayName: input.email || input.subject },
    );
  } catch (cause) {
    if (createdDatabase) {
      await dropWorkspaceDatabase(systemDb, dbName);
    }
    throw new Error(`workspace template apply failed for ${dbName}`, { cause });
  }

  try {
    await createSystemWorkspaceIndex(systemDb, input, dbName);
  } catch (cause) {
    if (createdDatabase) {
      await dropWorkspaceDatabase(systemDb, dbName);
    }
    if (isSlugConflict(cause)) {
      return { kind: "slug-conflict" };
    }
    if (isDbNameConflict(cause)) {
      return { kind: "db-name-conflict" };
    }
    throw new Error(`workspace _system write failed for ${dbName}`, { cause });
  }

  // IdP scope 更新失败不删库，允许前端重试 switch-workspace。
  try {
    const scopeToken = await idpTokenScopeAdapter.updateUserScope({
      subjectToken: input.subjectToken,
      scope: { db: dbName, ac: "admin" },
    });
    return {
      kind: "created",
      slug: input.slug,
      dbName,
      accessToken: scopeToken.accessToken,
      expiresIn: scopeToken.expiresIn,
    };
  } catch {
    return { kind: "scope-update-failed", slug: input.slug, dbName };
  }
}

async function createSystemWorkspaceIndex(
  systemDb: CreateWorkspaceClient,
  input: CreateWorkspaceInput,
  dbName: string,
): Promise<void> {
  await systemDb.query(
    `BEGIN TRANSACTION;
     IF array::len((SELECT VALUE id FROM workspace WHERE slug = $slug LIMIT 1)) > 0 {
       THROW "workspace-slug-conflict";
     };
     IF array::len((SELECT VALUE id FROM workspace WHERE db_name = $dbName LIMIT 1)) > 0 {
       THROW "workspace-db-conflict";
     };
     LET $workspace = CREATE ONLY workspace CONTENT {
       db_name: $dbName,
       owner_subject: $subject,
       slug: $slug,
       name: $name,
       status: "active"
     };
     INSERT INTO user_workspace_index {
       subject: $subject,
       email: $email,
       workspace: $workspace.id,
       db_name: $dbName,
       role: $role,
       last_selected_at: time::now()
     }
     ON DUPLICATE KEY UPDATE role = $role, db_name = $dbName, last_selected_at = time::now();
     COMMIT TRANSACTION;`,
    { dbName, subject: input.subject, email: input.email, slug: input.slug, name: input.name, role: "admin" },
  );
}

function isSlugConflict(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  return message.includes("workspace-slug-conflict") || message.includes("workspace_slug_unique");
}

function isDbNameConflict(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  return (
    message.includes("workspace-db-conflict") ||
    message.includes("workspace_db_name_unique") ||
    (message.includes("database") && message.includes("already exists"))
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function dropWorkspaceDatabase(
  client: CreateWorkspaceClient,
  dbName: string,
): Promise<void> {
  try {
    await client.query(`REMOVE DATABASE IF EXISTS ${dbName};`);
  } catch {
    // 补偿删除失败：记录需人工清理的错误码，不掩盖原始失败。
    console.error("[create-workspace]", `compensation drop failed for ${dbName}; manual cleanup required`);
  }
}
