import { mapNullToSurrealNone } from "@surreal-ck/shared/surreal-values";
import { toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";

/**
 * 个人中心身份卡的数据层（纯逻辑，无 Svelte runes）。
 *
 * 作用域 = 当前 workspace db 的 `user` 表，浏览器直连读写——不走后端代理。
 * 「当前用户是哪一行」统一用 `fn::current_user()` 解析：admin 会话（TYPE JWT，
 * $auth=NONE）按 $token.sub 反查，participant/employee（TYPE RECORD）走 $auth.id。
 * 业务代码因此**绝不**依赖 $auth 定位当前用户。
 */

/** 身份卡读回的当前用户快照；record id 以 `table:id` 字符串形态在内存流转。 */
export type CurrentUserProfile = {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
};

/** 数据库 `user` 行的最小形状（仅身份卡用到的字段）。 */
type UserRow = {
  id: { toString(): string };
  email: string;
  display_name?: string | null;
  is_admin?: boolean;
};

/**
 * 读取当前用户（db 为 single source of truth，不读登录 claim 快照）。
 * `fn::current_user()` 解析不到（root 维护连接 / 异常会话）时返回 null，
 * 调用方据此进入「无法定位当前用户」错误态。
 */
export async function loadCurrentUser(conn: SurrealConn): Promise<CurrentUserProfile | null> {
  // 不用 FROM ONLY：conn.query 取首个语句的结果集并按数组对待，ONLY 会返回单对象
  // 破坏该契约。LIMIT 1 + rows[0] 即可拿到当前用户行。
  const rows = await conn.query<UserRow>(
    "SELECT * FROM user WHERE id = fn::current_user() LIMIT 1",
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id.toString(),
    email: row.email,
    displayName: row.display_name ?? null,
    isAdmin: row.is_admin === true,
  };
}

/** 保存结果：成功，或带一条人类可读错误（UI 直接展示）。 */
export type SaveProfileResult =
  | { ok: true; displayName: string | null }
  | { ok: false; message: string };

/**
 * 保存 display_name。空名（trim 后为空）写 NONE（undefined），不写 JS null——
 * `display_name` 是 option<string>，引擎拒 null。明确 UPDATE 该 record id，
 * id 在 SDK 边界包成 RecordId。
 */
export async function saveDisplayName(
  conn: SurrealConn,
  userId: string,
  rawName: string,
): Promise<SaveProfileResult> {
  const trimmed = rawName.trim();
  const next = trimmed === "" ? null : trimmed;
  try {
    await conn.query("UPDATE $id SET display_name = $name", {
      id: toRecordId(userId),
      name: mapNullToSurrealNone(next),
    });
    return { ok: true, displayName: next };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
