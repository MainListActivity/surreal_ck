import { RecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { ServiceError } from "./errors";
import type { CurrentUserDTO, WorkspaceDTO } from "../../shared/rpc.types";

// ─── Token Claims ─────────────────────────────────────────────────────────────

export type TokenClaims = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  exp?: number;
};

/** 集中解码 JWT payload，所有模块统一从此处获取 claims，不各自拼 sub。 */
export function decodeTokenClaims(token: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new ServiceError("VALIDATION_ERROR", "无效的 JWT 格式");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new ServiceError("VALIDATION_ERROR", "JWT payload 解码失败");
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new ServiceError("VALIDATION_ERROR", "JWT 缺少 sub 字段");
  }
  return {
    sub: payload.sub as string,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    preferred_username:
      typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
  };
}

// ─── Bootstrap Result ─────────────────────────────────────────────────────────

export type BootstrapResult = {
  user: CurrentUserDTO;
  defaultWorkspace: WorkspaceDTO;
};

// ─── Identity Bootstrap ───────────────────────────────────────────────────────

/**
 * 用 claims 创建/更新本地 app_user，并确保有一个 owner workspace。
 * 幂等：重复调用不会创建重复用户或 workspace。
 * 必须在 initUserDb / tryRestoreSession 成功后调用（用户 DB 已就绪）。
 */
export async function bootstrapLocalIdentity(claims: TokenClaims): Promise<BootstrapResult> {
  if (!claims.sub) {
    throw new ServiceError("VALIDATION_ERROR", "claims 缺少 sub");
  }

  const db = getLocalDb();

  // 生成稳定的 user record id（sub 的哈希，与 userDbName 保持一致的派生策略）
  const userIdHex = Bun.hash.wyhash(claims.sub).toString(16).padStart(16, "0");
  const userId = new RecordId("app_user", userIdHex);

  // 计算 display_name：preferred_username > name > email > sub 前缀
  const displayName =
    claims.preferred_username ?? claims.name ?? claims.email?.split("@")[0] ?? claims.sub.slice(0, 8);

  // UPSERT app_user（ON DUPLICATE KEY UPDATE 语义：subject 索引唯一）
  const userRows = await db.query<[{ id: RecordId; subject: string; email?: string; name?: string; display_name?: string; avatar?: string }[]]>(
    `UPSERT $userId CONTENT {
      subject: $subject,
      email: $email,
      name: $name,
      display_name: $displayName,
      avatar: $avatar
    }`,
    {
      userId,
      subject: claims.sub,
      email: claims.email,
      name: claims.name,
      displayName,
      avatar: claims.picture,
    }
  );

  const userRow = userRows[0]?.[0];
  if (!userRow) {
    throw new ServiceError("INTERNAL_ERROR", "app_user 写入失败");
  }

  const user: CurrentUserDTO = {
    id: String(userRow.id),
    subject: userRow.subject,
    email: userRow.email,
    name: userRow.name,
    displayName: userRow.display_name,
    avatar: userRow.avatar,
  };

  // 查询是否已有 owner workspace
  const wsRows = await db.query<[{ id: RecordId; name: string; slug: string }[]]>(
    `SELECT id, name, slug FROM workspace WHERE owner = $userId LIMIT 1`,
    { userId }
  );
  let wsRow = wsRows[0]?.[0];

  if (!wsRow) {
    // 生成默认 slug（display_name 转 slug，截断 + 哈希后缀保证唯一）
    const slugBase = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20);
    const suffix = userIdHex.slice(0, 6);
    const slug = `${slugBase || "workspace"}-${suffix}`;

    const wsId = new RecordId("workspace", Bun.hash.wyhash(`${claims.sub}:default`).toString(16).padStart(16, "0"));

    const newWsRows = await db.query<[{ id: RecordId; name: string; slug: string }[]]>(
      `UPSERT $wsId CONTENT {
        owner: $userId,
        name: $wsName,
        slug: $slug
      }`,
      {
        wsId,
        userId,
        wsName: `${displayName} 的工作区`,
        slug,
      }
    );

    wsRow = newWsRows[0]?.[0];
    if (!wsRow) {
      throw new ServiceError("INTERNAL_ERROR", "默认 workspace 创建失败");
    }
  }

  return {
    user,
    defaultWorkspace: {
      id: String(wsRow.id),
      name: wsRow.name,
      slug: wsRow.slug,
    },
  };
}
