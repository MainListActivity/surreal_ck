import { RecordId, StringRecordId } from "surrealdb";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";

export type MemberManagerClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type MemberManagerSessionFactory = (database: string, namespace: string) => Promise<MemberManagerClient>;

export type AddMemberInput = {
  callerSubject: string;
  slug: string;
  email: string;
  displayName?: string;
  isAdmin: boolean;
};

export type AddMemberResult =
  | { kind: "added" }
  | { kind: "forbidden" }
  | { kind: "workspace-not-found" };

export type UpdateMemberRoleInput = {
  callerSubject: string;
  slug: string;
  userId: string;
  isAdmin: boolean;
};

export type UpdateMemberRoleResult =
  | { kind: "updated" }
  | { kind: "forbidden" }
  | { kind: "workspace-not-found" }
  | { kind: "member-not-found" };

export type RemoveMemberInput = {
  callerSubject: string;
  slug: string;
  userId: string;
};

export type RemoveMemberResult =
  | { kind: "removed" }
  | { kind: "forbidden" }
  | { kind: "workspace-not-found" }
  | { kind: "member-not-found" };

export interface MemberManager {
  addMember(input: AddMemberInput): Promise<AddMemberResult>;
  updateMemberRole(input: UpdateMemberRoleInput): Promise<UpdateMemberRoleResult>;
  removeMember(input: RemoveMemberInput): Promise<RemoveMemberResult>;
}

export type MemberManagerOptions = {
  getDbSession?: MemberManagerSessionFactory;
  namespace?: string;
};

const SYSTEM_DATABASE = "_system";

async function defaultGetDbSession(database: string, namespace: string): Promise<MemberManagerClient> {
  return getRootDatabaseSession(database, namespace);
}

type WorkspaceRef = { workspaceId: StringRecordId; dbName: string };

function roleFor(isAdmin: boolean): "admin" | "participant" {
  return isAdmin ? "admin" : "participant";
}

export function createMemberManager(options: MemberManagerOptions = {}): MemberManager {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession ?? defaultGetDbSession;

  async function resolveWorkspace(systemDb: MemberManagerClient, slug: string): Promise<WorkspaceRef | null> {
    const result = await systemDb.query(
      "SELECT id, db_name, status FROM workspace WHERE slug = $slug LIMIT 1;",
      { slug },
    );
    const row = firstRow(result);
    if (!row || readString(row, "db_name") === null || readString(row, "status") !== "active") {
      return null;
    }
    const workspaceId = toStringRecordId(Reflect.get(row, "id"));
    if (!workspaceId) {
      return null;
    }
    return { workspaceId, dbName: readString(row, "db_name") as string };
  }

  async function callerIsAdmin(workspaceDb: MemberManagerClient, callerSubject: string): Promise<boolean> {
    const result = await workspaceDb.query(
      "SELECT is_admin FROM user WHERE kind = 'human' AND subject = $callerSubject AND disabled_at = NONE LIMIT 1;",
      { callerSubject },
    );
    const row = firstRow(result);
    return row !== null && Reflect.get(row, "is_admin") === true;
  }

  // 读目标 human member（by record id），用于 PATCH / DELETE 定位与回查 email。
  async function readTargetMember(
    workspaceDb: MemberManagerClient,
    userRecord: RecordId,
  ): Promise<{ email: string } | null> {
    const result = await workspaceDb.query(
      "SELECT email, kind FROM $userRecord WHERE kind = 'human';",
      { userRecord },
    );
    const row = firstRow(result);
    const email = row ? readString(row, "email") : null;
    return email === null ? null : { email };
  }

  return {
    async addMember(input) {
      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);
      const workspace = await resolveWorkspace(systemDb, input.slug);
      if (!workspace) {
        return { kind: "workspace-not-found" };
      }

      const workspaceDb = await getDbSession(workspace.dbName, namespace);
      if (!(await callerIsAdmin(workspaceDb, input.callerSubject))) {
        return { kind: "forbidden" };
      }

      const role = roleFor(input.isAdmin);

      // 预创建的 human user 尚无 OIDC subject：subject 留 NONE，由首次登录
      // (switch-workspace 按 email 绑定) 回填。email 带唯一索引，用 ON DUPLICATE KEY UPDATE 兜冲突。
      await workspaceDb.query(
        `INSERT INTO user {
           email: $email,
           display_name: $displayName,
           kind: "human",
           is_admin: $isAdmin
         }
         ON DUPLICATE KEY UPDATE
           display_name = $displayName,
           is_admin = $isAdmin,
           disabled_at = NONE;`,
        { email: input.email, displayName: input.displayName ?? input.email, isAdmin: input.isAdmin },
      );

      // _system 索引行：subject NONE（NONE 不参与 (subject, workspace) 唯一索引约束），
      // workspace 为 RecordId。
      await systemDb.query(
        `INSERT INTO user_workspace_index {
           subject: NONE,
           email: $email,
           workspace: $workspace,
           db_name: $dbName,
           role: $role
         };`,
        { email: input.email, workspace: workspace.workspaceId, dbName: workspace.dbName, role },
      );

      return { kind: "added" };
    },

    async updateMemberRole(input) {
      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);
      const workspace = await resolveWorkspace(systemDb, input.slug);
      if (!workspace) {
        return { kind: "workspace-not-found" };
      }

      const workspaceDb = await getDbSession(workspace.dbName, namespace);
      if (!(await callerIsAdmin(workspaceDb, input.callerSubject))) {
        return { kind: "forbidden" };
      }

      const userRecord = new RecordId("user", input.userId);
      const target = await readTargetMember(workspaceDb, userRecord);
      if (!target) {
        return { kind: "member-not-found" };
      }

      const role = roleFor(input.isAdmin);

      // ws db user 是 DDL 权限真相源，先写它；再把 _system 索引 role 拉齐到同一值。
      await workspaceDb.query("UPDATE $userRecord SET is_admin = $isAdmin;", {
        userRecord,
        isAdmin: input.isAdmin,
      });

      // index 行靠 (workspace, email) 关联（subject 可能为 NONE）。
      await systemDb.query(
        "UPDATE user_workspace_index SET role = $role WHERE workspace = $workspace AND email = $email;",
        { role, workspace: workspace.workspaceId, email: target.email },
      );

      return { kind: "updated" };
    },

    async removeMember(input) {
      const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);
      const workspace = await resolveWorkspace(systemDb, input.slug);
      if (!workspace) {
        return { kind: "workspace-not-found" };
      }

      const workspaceDb = await getDbSession(workspace.dbName, namespace);
      if (!(await callerIsAdmin(workspaceDb, input.callerSubject))) {
        return { kind: "forbidden" };
      }

      const userRecord = new RecordId("user", input.userId);
      const target = await readTargetMember(workspaceDb, userRecord);
      if (!target) {
        return { kind: "member-not-found" };
      }

      // 软移除：只写 disabled_at，保留 user record 让历史 office_* / workflow_run /
      // 业务记录的 $auth 归因不悬空。
      await workspaceDb.query("UPDATE $userRecord SET disabled_at = time::now();", { userRecord });

      await systemDb.query(
        "UPDATE user_workspace_index SET disabled_at = time::now() WHERE workspace = $workspace AND email = $email;",
        { workspace: workspace.workspaceId, email: target.email },
      );

      return { kind: "removed" };
    },
  };
}

function firstRow(result: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(result) ? result[0] : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = Reflect.get(row, key);
  return typeof value === "string" ? value : null;
}
