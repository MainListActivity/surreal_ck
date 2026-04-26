import { getLocalDb } from "../db/index";
import { getServiceContext } from "./context";

type ClientErrorMeta = {
  screen?: string;
  workbookId?: string;
  [key: string]: unknown;
};

/** 记录客户端侧的服务错误，写入 client_error 表，失败静默。 */
export async function recordClientError(
  errorCode: string,
  message: string,
  meta?: ClientErrorMeta
): Promise<void> {
  try {
    const ctx = getServiceContext();
    if (!ctx.isAuthenticated) return;

    const db = getLocalDb();
    await db.query(
      `CREATE client_error CONTENT {
        error_code: $code,
        message: $msg,
        meta: $meta,
        created_at: time::now()
      }`,
      { code: errorCode, msg: message, meta: meta ?? {} }
    );
  } catch {
    // 审计失败不应影响主流程
  }
}
