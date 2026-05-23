import {
  loadTemplateScripts as loadTemplateScriptsDefault,
  type WorkspaceTemplateScript,
} from "@surreal-ck/shared/workspace-template";
import { env } from "../env";
import { getRootConnection } from "../db/root-connection";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import { createIdpTokenScopeAdapter } from "./idp-scope-adapter";

export type CreateWorkspaceClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type CreateWorkspaceInput = {
  subject: string;
  email: string;
  name: string;
  slug: string;
};

export type CreateWorkspaceResult =
  | {
      kind: "created";
      slug: string;
      dbName: string;
      refreshRequired: true;
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
  db?: CreateWorkspaceClient;
  idpTokenScopeAdapter?: IdpTokenScopeAdapter;
  loadTemplateScripts?: () => Promise<WorkspaceTemplateScript[]>;
  generateId?: () => string;
  namespace?: string;
};

const SYSTEM_DATABASE = "_system";

function defaultGenerateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function createWorkspaceCreator(options: CreateWorkspaceCreatorOptions = {}): WorkspaceCreator {
  const idpTokenScopeAdapter = options.idpTokenScopeAdapter ?? createIdpTokenScopeAdapter();
  const loadScripts = options.loadTemplateScripts ?? (() => loadTemplateScriptsDefault({ oidcJwksUrl: env.OIDC_JWKS_URL }));
  const generateId = options.generateId ?? defaultGenerateId;
  const namespace = options.namespace ?? env.SURREAL_NS;

  return {
    async createWorkspace(input) {
      // root 连接延迟到调用时解析，与 scope module / idp adapter 一致，避免装配期连接未就绪。
      const client = options.db ?? getRootConnection();
      const dbName = `ws_${generateId()}`;

      // slug 唯一性预检：命中即 409，不建库。
      await client.use({ namespace, database: SYSTEM_DATABASE });
      const slugResult = await client.query("SELECT id FROM workspace WHERE slug = $slug LIMIT 1;", {
        slug: input.slug,
      });
      if (rowCount(slugResult) > 0) {
        return { kind: "slug-conflict" };
      }

      // root 建库 + 应用模板 + 写 owner user。
      await client.query(`DEFINE DATABASE IF NOT EXISTS ${dbName};`);
      try {
        await client.use({ namespace, database: dbName });
        const scripts = await loadScripts();
        for (const script of scripts) {
          await client.query(script.sql);
        }

        await client.query(
          `INSERT INTO user {
             subject: $subject,
             email: $email,
             display_name: $displayName,
             kind: "human",
             is_admin: true,
             last_seen_at: time::now()
           }
           ON DUPLICATE KEY UPDATE is_admin = true, last_seen_at = time::now();`,
          { subject: input.subject, email: input.email, displayName: input.email },
        );
      } catch (cause) {
        await dropWorkspaceDatabase(client, namespace, dbName, cause);
        throw new Error(`workspace template apply failed for ${dbName}`, { cause });
      }

      // _system 双写：workspace + user_workspace_index。
      try {
        await client.use({ namespace, database: SYSTEM_DATABASE });
        await client.query(
          `CREATE workspace CONTENT {
             db_name: $dbName,
             owner_subject: $subject,
             slug: $slug,
             name: $name,
             status: "active"
           };`,
          { dbName, subject: input.subject, slug: input.slug, name: input.name },
        );
        await client.query(
          `INSERT INTO user_workspace_index {
             subject: $subject,
             email: $email,
             workspace: (SELECT VALUE id FROM workspace WHERE slug = $slug LIMIT 1)[0],
             db_name: $dbName,
             role: $role,
             last_selected_at: time::now()
           }
           ON DUPLICATE KEY UPDATE role = $role, db_name = $dbName, last_selected_at = time::now();`,
          { subject: input.subject, email: input.email, slug: input.slug, dbName, role: "admin" },
        );
      } catch (cause) {
        await dropWorkspaceDatabase(client, namespace, dbName, cause);
        throw new Error(`workspace _system write failed for ${dbName}`, { cause });
      }

      // IdP scope 更新失败不删库，允许前端重试 switch-workspace。
      try {
        await idpTokenScopeAdapter.updateUserScope(input.subject, { db: dbName, ac: "admin" });
      } catch {
        return { kind: "scope-update-failed", slug: input.slug, dbName };
      }

      return { kind: "created", slug: input.slug, dbName, refreshRequired: true };
    },
  };
}

function rowCount(result: unknown): number {
  const rows = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(rows) ? rows.length : 0;
}

async function dropWorkspaceDatabase(
  client: CreateWorkspaceClient,
  namespace: string,
  dbName: string,
  cause: unknown,
): Promise<void> {
  try {
    await client.use({ namespace, database: SYSTEM_DATABASE });
    await client.query(`REMOVE DATABASE IF EXISTS ${dbName};`);
  } catch {
    // 补偿删除失败：记录需人工清理的错误码，不掩盖原始失败。
    console.error("[create-workspace]", `compensation drop failed for ${dbName}; manual cleanup required`);
  }
}
