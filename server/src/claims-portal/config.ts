import { env, type ServerEnv } from "../env";

export type ClaimsAttachmentConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
};

/** pepper 至少 32 字符才视为已配置。 */
export function getClaimsPortalPepper(source: Pick<ServerEnv, "CLAIMS_PORTAL_TOKEN_PEPPER"> = env): string | null {
  const pepper = source.CLAIMS_PORTAL_TOKEN_PEPPER;
  return typeof pepper === "string" && pepper.length >= 32 ? pepper : null;
}

/** 五个附件键必须齐备；否则返回 null（fail-closed）。 */
export function getClaimsAttachmentConfig(
  source: Pick<
    ServerEnv,
    | "CLAIMS_ATTACHMENT_ACCOUNT_ID"
    | "CLAIMS_ATTACHMENT_ACCESS_KEY_ID"
    | "CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY"
    | "CLAIMS_ATTACHMENT_BUCKET"
    | "CLAIMS_ATTACHMENT_ENDPOINT"
  > = env,
): ClaimsAttachmentConfig | null {
  const accountId = source.CLAIMS_ATTACHMENT_ACCOUNT_ID;
  const accessKeyId = source.CLAIMS_ATTACHMENT_ACCESS_KEY_ID;
  const secretAccessKey = source.CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY;
  const bucket = source.CLAIMS_ATTACHMENT_BUCKET;
  const endpoint = source.CLAIMS_ATTACHMENT_ENDPOINT;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}
