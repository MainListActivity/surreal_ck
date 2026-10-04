import { S3Client } from "bun";
import { HttpError } from "../http-error";
import type { ClaimsAttachmentConfig } from "./config";

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
      throw new HttpError(
        502,
        "attachment-upload-failed",
        `R2 upload failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
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
    try {
      await client.write(input.key, input.bytes, { type: input.contentType });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      throw new HttpError(502, "attachment-upload-failed", `R2 S3 upload failed: ${message.slice(0, 200)}`);
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
