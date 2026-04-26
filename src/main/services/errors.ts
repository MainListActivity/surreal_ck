import type { AppError, AppErrorCode, AppOk, Result } from "../../shared/rpc.types";

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  NOT_AUTHENTICATED: "请先登录",
  OFFLINE_READ_ONLY: "当前处于离线只读模式，无法执行写操作",
  NOT_IMPLEMENTED: "功能尚未实现",
  BOOTSTRAP_REQUIRED: "用户身份尚未初始化，请重新登录",
  VALIDATION_ERROR: "请求参数无效",
  INTERNAL_ERROR: "服务内部错误",
};

export class ServiceError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message?: string
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "ServiceError";
  }
}

export function toAppError(code: AppErrorCode, message?: string): AppError {
  return {
    ok: false,
    code,
    message: message || DEFAULT_MESSAGES[code],
  };
}

export function toAppOk<T>(data: T): AppOk<T> {
  return { ok: true, data };
}

/** 将任意 Error 或未知值安全映射为可序列化的 AppError，不泄露 stack。 */
export function catchToAppError(err: unknown): AppError {
  if (err instanceof ServiceError) {
    return toAppError(err.code, err.message);
  }
  if (err instanceof Error) {
    return toAppError("INTERNAL_ERROR", err.message || DEFAULT_MESSAGES.INTERNAL_ERROR);
  }
  return toAppError("INTERNAL_ERROR");
}

/** 包装 async handler，捕获所有异常并返回 Result<T>。 */
export async function withResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const data = await fn();
    return toAppOk(data);
  } catch (err) {
    return catchToAppError(err);
  }
}
