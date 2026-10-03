import { HttpError } from "../http-error";
import {
  ALLOWED_ATTACHMENT_MIME,
  ALLOWED_ATTACHMENT_TYPES,
  INTEREST_METHOD_SIMPLE,
  MAX_ATTACHMENT_BYTES,
  type AllowedAttachmentType,
} from "./constants";

export type RateSegmentInput = {
  annual_rate?: unknown;
  start?: unknown;
  end?: unknown;
  [key: string]: unknown;
};

export type SubmissionDraftInput = {
  principal?: unknown;
  rate_segments?: unknown;
  interest_start?: unknown;
  interest_end?: unknown;
  interest_method?: unknown;
  penalty?: unknown;
  statement?: unknown;
};

export type NormalizedDraft = {
  principal: number | null;
  rate_segments: Array<Record<string, unknown>> | null;
  interest_start: string | null;
  interest_end: string | null;
  interest_method: typeof INTEREST_METHOD_SIMPLE | null;
  penalty: number | null;
  statement: string | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeDraft(input: SubmissionDraftInput): NormalizedDraft {
  let principal: number | null = null;
  if (input.principal !== undefined && input.principal !== null) {
    if (!isFiniteNumber(input.principal) || input.principal < 0) {
      throw new HttpError(400, "claims-draft-invalid", "principal must be a non-negative number");
    }
    principal = input.principal;
  }

  let rate_segments: Array<Record<string, unknown>> | null = null;
  if (input.rate_segments !== undefined && input.rate_segments !== null) {
    if (!Array.isArray(input.rate_segments)) {
      throw new HttpError(400, "claims-draft-invalid", "rate_segments must be an array");
    }
    rate_segments = input.rate_segments.map((segment) => {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
        throw new HttpError(400, "claims-draft-invalid", "rate_segments entries must be objects");
      }
      return { ...(segment as Record<string, unknown>) };
    });
  }

  let interest_start: string | null = null;
  if (input.interest_start !== undefined && input.interest_start !== null) {
    if (typeof input.interest_start !== "string" || Number.isNaN(Date.parse(input.interest_start))) {
      throw new HttpError(400, "claims-draft-invalid", "interest_start must be an ISO date string");
    }
    interest_start = input.interest_start;
  }

  let interest_end: string | null = null;
  if (input.interest_end !== undefined && input.interest_end !== null) {
    if (typeof input.interest_end !== "string" || Number.isNaN(Date.parse(input.interest_end))) {
      throw new HttpError(400, "claims-draft-invalid", "interest_end must be an ISO date string");
    }
    interest_end = input.interest_end;
  }

  if (interest_start && interest_end && Date.parse(interest_end) <= Date.parse(interest_start)) {
    throw new HttpError(400, "claims-draft-invalid", "interest_end must be after interest_start");
  }

  let interest_method: typeof INTEREST_METHOD_SIMPLE | null = null;
  if (input.interest_method !== undefined && input.interest_method !== null) {
    if (input.interest_method !== INTEREST_METHOD_SIMPLE) {
      throw new HttpError(400, "claims-draft-invalid", "interest_method must be simple");
    }
    interest_method = INTEREST_METHOD_SIMPLE;
  }

  let penalty: number | null = null;
  if (input.penalty !== undefined && input.penalty !== null) {
    if (!isFiniteNumber(input.penalty) || input.penalty < 0) {
      throw new HttpError(400, "claims-draft-invalid", "penalty must be a non-negative number");
    }
    penalty = input.penalty;
  }

  let statement: string | null = null;
  if (input.statement !== undefined && input.statement !== null) {
    if (typeof input.statement !== "string" || input.statement.length > 8192) {
      throw new HttpError(400, "claims-draft-invalid", "statement must be a string up to 8192 chars");
    }
    statement = input.statement;
  }

  return {
    principal,
    rate_segments,
    interest_start,
    interest_end,
    interest_method,
    penalty,
    statement,
  };
}

export function assertAttachmentMeta(input: {
  attachmentType: unknown;
  fileName: unknown;
  contentType: unknown;
  byteSize: unknown;
}): {
  attachmentType: AllowedAttachmentType;
  fileName: string;
  contentType: string;
  byteSize: number;
} {
  if (
    typeof input.attachmentType !== "string"
    || !(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(input.attachmentType)
  ) {
    throw new HttpError(400, "claims-attachment-type-invalid", "attachment_type must be contract|statement|judgment");
  }
  if (typeof input.fileName !== "string" || input.fileName.trim().length === 0 || input.fileName.length > 512) {
    throw new HttpError(400, "claims-attachment-name-invalid", "file_name is required");
  }
  if (typeof input.contentType !== "string" || !(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(input.contentType)) {
    throw new HttpError(400, "claims-attachment-mime-invalid", "content_type must be pdf/png/jpeg");
  }
  if (typeof input.byteSize !== "number" || !Number.isFinite(input.byteSize) || input.byteSize < 0) {
    throw new HttpError(400, "claims-attachment-size-invalid", "byte_size must be a non-negative number");
  }
  if (input.byteSize > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(400, "claims-attachment-too-large", `byte_size must be <= ${MAX_ATTACHMENT_BYTES}`);
  }
  return {
    attachmentType: input.attachmentType as AllowedAttachmentType,
    fileName: input.fileName.trim(),
    contentType: input.contentType,
    byteSize: Math.floor(input.byteSize),
  };
}
