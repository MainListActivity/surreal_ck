import { createHmac } from "node:crypto";
import { env } from "../env";

/**
 * 工作区标识哈希（任务 d70c3748 第 4 版 §2）。
 *
 * workspace_key = HMAC-SHA256(FUNNEL_HASH_KEY, db_name) 的十六进制摘要。
 * 无密钥的 SHA-256 可通过枚举 `sck-` 前缀 slug 还原，不满足「不可逆」要求，
 * 因此密钥未配置时返回 null，聚合任务不得写入计数。密钥经
 * `gh secret set ORIGIN_ENV_FUNNEL_HASH_KEY --env production` 下发。
 */
export function workspaceKey(dbName: string, hashKey: string = env.FUNNEL_HASH_KEY ?? ""): string | null {
  if (!hashKey) return null;
  return createHmac("sha256", hashKey).update(dbName).digest("hex");
}
