/** 同一令牌失败计数窗口（15 分钟）。 */
export const FAIL_WINDOW_MS = 15 * 60 * 1000;

/** 窗口内失败次数达到该阈值后锁定。 */
export const FAIL_THRESHOLD = 5;

/** 超限后锁定时长（30 分钟）。 */
export const LOCK_MS = 30 * 60 * 1000;

/** 门户会话有效期（8 小时）。 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** 统一失败文案：不区分姓名 / 识别码哪一项错。 */
export const OPEN_FAILURE_MESSAGE = "姓名或识别码不正确";

export const SESSION_COOKIE_NAME = "claims_portal_sess";

export const ALLOWED_ATTACHMENT_TYPES = ["contract", "statement", "judgment"] as const;
export type AllowedAttachmentType = (typeof ALLOWED_ATTACHMENT_TYPES)[number];

export const ALLOWED_ATTACHMENT_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
] as const;

/** 单附件大小上限：20MB。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const INTEREST_METHOD_SIMPLE = "simple" as const;
