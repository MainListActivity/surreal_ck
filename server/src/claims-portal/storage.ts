import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { S3Client } from "bun";
import { HttpError } from "../http-error";
import type { ClaimsAttachmentConfig } from "./config";

/** 上传暂存盘最低可用空间（64MB）。 */
export const UPLOAD_DISK_MIN_HEADROOM_BYTES = 64 * 1024 * 1024;

/** 上传所需 headroom：至少 64MB，或待写字节数的 2 倍。 */
export function requiredUploadHeadroomBytes(requiredBytes: number): number {
  const bytes = Number.isFinite(requiredBytes) && requiredBytes > 0 ? requiredBytes : 0;
  return Math.max(UPLOAD_DISK_MIN_HEADROOM_BYTES, bytes * 2);
}

/** os.tmpdir() 所在卷可用字节数（bavail * bsize）。 */
export async function getTmpDirAvailableBytes(): Promise<number> {
  const stats = await statfs(tmpdir());
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * R2/S3 错误映射：507 / QuotaExceeded / InsufficientStorage → 507 attachment-storage-full；
 * 413 / EntityTooLarge → 413 attachment-too-large。映射后的 message 为固定文案，
 * 不携带宿主机路径、对象键或凭证；其它错误保留 502 + 截断 detail。
 */
export function mapAttachmentStorageUploadError(status: number | null, detail: string): HttpError {
  const text = detail.toLowerCase();
  if (
    status === 507
    || text.includes("quotaexceeded")
    || text.includes("quota exceeded")
    || text.includes("insufficientstorage")
    || text.includes("insufficient storage")
  ) {
    return new HttpError(507, "attachment-storage-full", "附件存储空间不足，请稍后重试");
  }
  if (
    status === 413
    || text.includes("entitytoolarge")
    || text.includes("entity too large")
  ) {
    return new HttpError(413, "attachment-too-large", "附件超出大小限制");
  }
  return new HttpError(
    502,
    "attachment-upload-failed",
    `R2 upload failed (${status ?? "error"})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
  );
}

export type PutObjectInput = {
  key: string;
  bytes: Uint8Array;
  contentType: string;
};

export type GetObjectResult = {
  body: Uint8Array;
  contentType: string;
  contentLength: number;
};

/** 附件对象存储：上传与受控读取。 */
export type ClaimsAttachmentStorage = {
  putObject: (input: PutObjectInput) => Promise<void>;
  getObject: (key: string) => Promise<GetObjectResult>;
};

function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/[/\\]/g, "_").trim();
  return base.length > 0 ? base.slice(0, 200) : "attachment";
}

/** 对象键：claims/{workspaceDb}/{submissionId}/{attachmentId}/{filename} */
export function buildClaimsAttachmentKey(input: {
  workspaceDb: string;
  submissionId: string;
  attachmentId: string;
  fileName: string;
}): string {
  const submissionId = input.submissionId.includes(":")
    ? input.submissionId.split(":").slice(1).join(":")
    : input.submissionId;
  const attachmentId = input.attachmentId.includes(":")
    ? input.attachmentId.split(":").slice(1).join(":")
    : input.attachmentId;
  return [
    "claims",
    input.workspaceDb,
    submissionId,
    attachmentId,
    sanitizeFileName(input.fileName),
  ].join("/");
}

/**
 * Cloudflare REST Objects API（Bearer token）。
 * 触发条件：endpoint 含 api.cloudflare.com；secretAccessKey 为 API token。
 */
export function createCloudflareApiAttachmentStorage(
  config: ClaimsAttachmentConfig,
): ClaimsAttachmentStorage {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/objects`;

  async function putObject(input: PutObjectInput): Promise<void> {
    const url = `${base}/${encodeObjectKeyPath(input.key)}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.secretAccessKey}`,
        "Content-Type": input.contentType,
      },
      body: input.bytes,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw mapAttachmentStorageUploadError(response.status, detail);
    }
  }

  async function getObject(key: string): Promise<GetObjectResult> {
    const url = `${base}/${encodeObjectKeyPath(key)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.secretAccessKey}` },
    });
    if (response.status === 404) {
      throw new HttpError(404, "attachment-object-missing", "Attachment object not found in storage");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        502,
        "attachment-download-failed",
        `R2 download failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return { body, contentType, contentLength: body.byteLength };
  }

  return { putObject, getObject };
}

/** S3 兼容（R2 endpoint + Access Key）。 */
export function createS3AttachmentStorage(config: ClaimsAttachmentConfig): ClaimsAttachmentStorage {
  const client = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
  });

  async function putObject(input: PutObjectInput): Promise<void> {
    // Bun S3Client.write 抛出的 S3Error 不携带 HTTP 状态码，裸 507/413
    // 无法与网络错误区分；改用 presign 生成 SigV4 PUT URL 后自行 fetch，
    // 拿到结构化 response.status 再映射。
    let response: Response;
    try {
      const url = client.presign(input.key, { method: "PUT", expiresIn: 900 });
      response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        body: input.bytes,
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "unknown";
      throw mapAttachmentStorageUploadError(null, message);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw mapAttachmentStorageUploadError(response.status, detail);
    }
  }

  async function getObject(key: string): Promise<GetObjectResult> {
    try {
      const file = client.file(key);
      const exists = await file.exists();
      if (!exists) {
        throw new HttpError(404, "attachment-object-missing", "Attachment object not found in storage");
      }
      const body = new Uint8Array(await file.arrayBuffer());
      const stat = await file.stat().catch(() => null);
      const contentType =
        (stat && typeof stat.type === "string" && stat.type.length > 0)
          ? stat.type
          : "application/octet-stream";
      return { body, contentType, contentLength: body.byteLength };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "unknown";
      throw new HttpError(502, "attachment-download-failed", `R2 S3 download failed: ${message.slice(0, 200)}`);
    }
  }

  return { putObject, getObject };
}

/** endpoint 含 api.cloudflare.com → CF REST；否则 S3 兼容。 */
export function createAttachmentStorage(config: ClaimsAttachmentConfig): ClaimsAttachmentStorage {
  if (config.endpoint.includes("api.cloudflare.com")) {
    return createCloudflareApiAttachmentStorage(config);
  }
  return createS3AttachmentStorage(config);
}
