import { z } from "zod";

/** 平台法律内容 MCP 的稳定协议版本。 */
export const PLATFORM_CONTENT_CONTRACT_VERSION = "1" as const;

export const PLATFORM_CONTENT_LIMITS = {
  maxBatchItems: 50,
  maxRequestBytes: 5 * 1024 * 1024,
  maxBodyTextBytes: 2 * 1024 * 1024,
  maxEvidenceTextBytes: 512 * 1024,
} as const;

export type PlatformContentLimits = {
  maxBatchItems: number;
  maxRequestBytes: number;
  maxBodyTextBytes: number;
  maxEvidenceTextBytes: number;
};

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeIntegerSchema = SafeIntegerSchema.nonnegative();

const PublicIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/\s/u.test(value), "公开 ID 不能包含空白字符");

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/u.test(value), "幂等键不能包含换行");

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu, "必须是 SHA-256 十六进制摘要");

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRfc3339Timestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    )
  ) {
    return false;
  }
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/u);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return false;
  return Number.isFinite(new Date(value).getTime());
}

export const PlatformContentTimestampSchema = z
  .string()
  .refine(isRfc3339Timestamp, "必须是带时区的 RFC 3339 时间戳");
export type PlatformContentTimestamp = z.infer<typeof PlatformContentTimestampSchema>;

export const PlatformContentDateSchema = z
  .string()
  .refine(isCalendarDate, "必须是 YYYY-MM-DD 日历日期");
export type PlatformContentDate = z.infer<typeof PlatformContentDateSchema>;

export const PlatformContentUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(isHttpUrl, "只允许带主机名的 http / https URL");

export const ContentKindSchema = z.enum(["legislation", "judicial_document"]);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const ContentSourceSchema = z.strictObject({
  sourceKey: PublicIdSchema,
  url: PlatformContentUrlSchema,
  recordKey: PublicIdSchema.nullable(),
  fetchedAt: PlatformContentTimestampSchema,
  publishedAt: PlatformContentTimestampSchema.nullable(),
  updatedAt: PlatformContentTimestampSchema.nullable(),
  publishedOn: PlatformContentDateSchema.nullable(),
  updatedOn: PlatformContentDateSchema.nullable(),
  dateText: z.string().trim().min(1).max(512).nullable(),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const SourceLocatorSchema = z.strictObject({
  page: NonNegativeIntegerSchema.nullable().optional(),
  paragraph: NonNegativeIntegerSchema.nullable().optional(),
  articleLabel: z.string().trim().min(1).max(128).nullable().optional(),
  text: z.string().trim().min(1).max(512).nullable().optional(),
});
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const DocumentEvidenceSchema = z.strictObject({
  text: z.string().trim().min(1),
  sourceLocator: SourceLocatorSchema.nullable().optional(),
  attachment: z
    .strictObject({
      url: PlatformContentUrlSchema,
      mediaType: z.string().trim().min(1).max(128),
      sha256: Sha256Schema,
      sizeBytes: NonNegativeIntegerSchema,
    })
    .nullable()
    .optional(),
});
export type DocumentEvidence = z.infer<typeof DocumentEvidenceSchema>;

export const FieldIssueSchema = z.strictObject({
  path: z.string().trim().min(1).max(512),
  code: z.enum([
    "unknown",
    "ambiguous",
    "missing_evidence",
    "conflicting_evidence",
    "unresolved",
    "invalid_value",
  ]),
  severity: z.enum(["warning", "blocking"]),
  message: z.string().trim().min(1).max(1024),
  evidenceRef: PublicIdSchema.nullable().optional(),
});
export type FieldIssue = z.infer<typeof FieldIssueSchema>;

export const ProcessingInfoSchema = z.strictObject({
  pipelineVersion: z.string().trim().min(1).max(128),
  methods: z.array(z.string().trim().min(1).max(128)).max(64),
  agentName: z.string().trim().min(1).max(128).nullable().optional(),
  model: z.string().trim().min(1).max(256).nullable().optional(),
  cleaningNotes: z.string().trim().max(4096).nullable().optional(),
});
export type ProcessingInfo = z.infer<typeof ProcessingInfoSchema>;

export const ContentDocumentSchema = z.strictObject({
  title: z.string().trim().min(1).max(4096),
  bodyText: z.string().min(1),
  sourceForm: z.enum(["full_text", "excerpt", "case_summary", "amendment_notice"]),
  evidence: z.array(DocumentEvidenceSchema).max(128),
  fieldIssues: z.array(FieldIssueSchema).max(256),
  processing: ProcessingInfoSchema,
  clientDigest: z
    .strictObject({ bodySha256: Sha256Schema, evidenceSha256: Sha256Schema.nullable().optional() })
    .nullable()
    .optional(),
});
export type ContentDocument = z.infer<typeof ContentDocumentSchema>;

export const VersionResolutionSchema = z.enum(["resolved", "unresolved", "ambiguous"]);
export const LegalStatusSchema = z.enum([
  "effective",
  "not_yet_effective",
  "repealed",
  "partially_effective",
  "unknown",
]);

export const LegalArticleSchema = z.strictObject({
  localKey: PublicIdSchema,
  label: z.string().trim().min(1).max(256),
  hierarchyPath: z.array(z.string().trim().min(1).max(256)).max(32),
  bodyText: z.string().min(1),
  locator: z
    .strictObject({ start: NonNegativeIntegerSchema, end: NonNegativeIntegerSchema, bodyDigest: Sha256Schema })
    .nullable()
    .optional(),
  sourceLocator: SourceLocatorSchema.nullable().optional(),
  effectiveOn: PlatformContentDateSchema.nullable(),
});
export type LegalArticle = z.infer<typeof LegalArticleSchema>;

export const LegislationMetadataSchema = z.strictObject({
  issuingAuthorities: z.array(z.string().trim().min(1).max(512)).max(32).nullable(),
  instrumentType: z.string().trim().min(1).max(256).nullable(),
  documentNumber: z.string().trim().min(1).max(256).nullable(),
  promulgatedOn: PlatformContentDateSchema.nullable(),
  effectiveOn: PlatformContentDateSchema.nullable(),
  repealedOn: PlatformContentDateSchema.nullable(),
  legalStatus: LegalStatusSchema.nullable(),
  versionLabel: z.string().trim().min(1).max(256).nullable(),
  versionResolution: VersionResolutionSchema,
  amendsRefs: z.array(PublicIdSchema).max(128),
  articles: z.array(LegalArticleSchema).max(4096),
});
export type LegislationMetadata = z.infer<typeof LegislationMetadataSchema>;

export const JudgmentOutcomeSchema = z.strictObject({
  disposition: z.string().trim().min(1).max(2048).nullable().optional(),
  claims: z.array(z.string().trim().min(1).max(1024)).max(256).optional(),
  amount: z.number().finite().nullable().optional(),
  currency: z.string().trim().min(1).max(32).nullable().optional(),
  evidenceRef: PublicIdSchema.nullable().optional(),
});
export type JudgmentOutcome = z.infer<typeof JudgmentOutcomeSchema>;

export const CitationRelationSchema = z.enum(["explicit_citation", "inferred_relation"]);
export const CitationSpeakerSchema = z.enum(["court", "party", "editor", "other", "unknown"]);
export const CitationResolutionSchema = z.enum(["unresolved", "ambiguous", "proposed", "verified"]);
export const CitationTreatmentSchema = z.enum(["applies", "rejects", "discusses", "unknown"]);

export const CitationLocatorSchema = z.strictObject({
  start: NonNegativeIntegerSchema,
  end: NonNegativeIntegerSchema,
  bodyDigest: Sha256Schema,
  sourceLocator: SourceLocatorSchema.nullable().optional(),
});
export type CitationLocator = z.infer<typeof CitationLocatorSchema>;

export const CitationCandidateSchema = z.strictObject({
  itemId: PublicIdSchema,
  versionId: PublicIdSchema.nullable().optional(),
  articleId: PublicIdSchema.nullable().optional(),
});
export type CitationCandidate = z.infer<typeof CitationCandidateSchema>;

export const ContentCitationSchema = z.strictObject({
  localCitationKey: PublicIdSchema,
  relationKind: CitationRelationSchema,
  speaker: CitationSpeakerSchema,
  quotedText: z.string().min(1).max(16384),
  locator: CitationLocatorSchema,
  rawLawName: z.string().trim().min(1).max(1024).nullable(),
  rawArticleLabel: z.string().trim().min(1).max(256).nullable(),
  resolution: CitationResolutionSchema,
  candidates: z.array(CitationCandidateSchema).max(32),
  treatment: CitationTreatmentSchema.nullable().optional(),
  treatmentEvidence: z.string().trim().min(1).max(4096).nullable().optional(),
});
export type ContentCitation = z.infer<typeof ContentCitationSchema>;

export const CitationExtractionStatusSchema = z.enum([
  "not_processed",
  "processed_none",
  "processed_partial",
  "processed_complete",
]);

export const JudgmentMetadataSchema = z.strictObject({
  documentType: z.string().trim().min(1).max(256).nullable(),
  caseNumber: z.string().trim().min(1).max(256).nullable(),
  court: z.string().trim().min(1).max(512).nullable(),
  decidedOn: PlatformContentDateSchema.nullable(),
  causeOfAction: z.string().trim().min(1).max(1024).nullable(),
  instance: z.string().trim().min(1).max(256).nullable(),
  procedure: z.string().trim().min(1).max(256).nullable(),
  outcome: JudgmentOutcomeSchema.nullable(),
  citationExtractionStatus: CitationExtractionStatusSchema,
  citations: z.array(ContentCitationSchema).max(4096),
});
export type JudgmentMetadata = z.infer<typeof JudgmentMetadataSchema>;

const BaseUpsertPayloadSchema = z.strictObject({
  source: ContentSourceSchema,
  document: ContentDocumentSchema,
  target: z
    .strictObject({ itemId: PublicIdSchema, expectedVersionId: PublicIdSchema.nullable().optional() })
    .nullable()
    .optional(),
});

export const LegislationUpsertPayloadSchema = BaseUpsertPayloadSchema.extend({
  kind: z.literal("legislation"),
  legislation: LegislationMetadataSchema,
});

export const JudicialDocumentUpsertPayloadSchema = BaseUpsertPayloadSchema.extend({
  kind: z.literal("judicial_document"),
  judgment: JudgmentMetadataSchema,
});

export const UpsertContentPayloadSchema = z.discriminatedUnion("kind", [
  LegislationUpsertPayloadSchema,
  JudicialDocumentUpsertPayloadSchema,
]);
export type UpsertContentPayload = z.infer<typeof UpsertContentPayloadSchema>;

export const ContentTargetSchema = z.strictObject({
  itemId: PublicIdSchema,
  expectedVersionId: PublicIdSchema.nullable().optional(),
  expectedPublicationRevision: NonNegativeIntegerSchema.nullable().optional(),
});
export type ContentTarget = z.infer<typeof ContentTargetSchema>;

export const WithdrawContentPayloadSchema = z.strictObject({
  target: ContentTargetSchema,
  reason: z.string().trim().min(1).max(4096),
  evidenceRefs: z.array(PublicIdSchema).max(128),
});
export type WithdrawContentPayload = z.infer<typeof WithdrawContentPayloadSchema>;

export const RestoreContentPayloadSchema = z.strictObject({
  target: ContentTargetSchema,
  reason: z.string().trim().min(1).max(4096),
  evidenceRefs: z.array(PublicIdSchema).max(128),
});
export type RestoreContentPayload = z.infer<typeof RestoreContentPayloadSchema>;

export const IngestionEntrySchema = z.discriminatedUnion("operation", [
  z.strictObject({ entryKey: PublicIdSchema, operation: z.literal("upsert"), payload: UpsertContentPayloadSchema }),
  z.strictObject({ entryKey: PublicIdSchema, operation: z.literal("withdraw"), payload: WithdrawContentPayloadSchema }),
  z.strictObject({ entryKey: PublicIdSchema, operation: z.literal("restore"), payload: RestoreContentPayloadSchema }),
]);
export type IngestionEntry = z.infer<typeof IngestionEntrySchema>;

export const IngestionBatchSchema = z.strictObject({
  contractVersion: z.literal(PLATFORM_CONTENT_CONTRACT_VERSION),
  idempotencyKey: IdempotencyKeySchema,
  supersedesBatchId: PublicIdSchema.nullable().optional(),
  items: z.array(IngestionEntrySchema).min(1).max(PLATFORM_CONTENT_LIMITS.maxBatchItems),
});
export type IngestionBatch = z.infer<typeof IngestionBatchSchema>;

export const PlatformContentErrorCodeSchema = z.enum([
  "unsupported_contract",
  "invalid_request",
  "forged_actor",
  "payload_too_large",
  "source_not_registered",
  "source_not_authorized",
  "required_field_missing",
  "locator_mismatch",
  "identity_ambiguous",
  "stale_version",
  "validation_stale",
  "idempotency_conflict",
  "publish_failed",
  "duplicate_entry_key",
  "duplicate_target",
]);
export type PlatformContentErrorCode = z.infer<typeof PlatformContentErrorCodeSchema>;

export const PlatformContentIssueSchema = z.strictObject({
  code: PlatformContentErrorCodeSchema,
  entryKey: PublicIdSchema.nullable().optional(),
  fieldPath: z.string().trim().min(1).max(512).nullable().optional(),
  message: z.string().trim().min(1).max(2048),
  retryable: z.boolean(),
  relatedVersionId: PublicIdSchema.nullable().optional(),
});
export type PlatformContentIssue = z.infer<typeof PlatformContentIssueSchema>;

export const ContractOperationSchema = z.enum([
  "get_data_contract",
  "search_content",
  "submit_batch",
  "inspect_batch",
  "publish_batch",
]);

export const GetDataContractRequestSchema = z.strictObject({
  contractVersion: z.string().nullable().optional(),
  sourceCursor: z.string().trim().min(1).nullable().optional(),
});
export type GetDataContractRequest = z.infer<typeof GetDataContractRequestSchema>;

export const ContractSourceSchema = z.strictObject({
  sourceKey: PublicIdSchema,
  label: z.string().trim().min(1).max(512),
  status: z.enum(["active", "inactive"]),
  allowedActions: z.array(z.enum(["submit", "publish", "withdraw", "restore"])).max(8),
});

export const GetDataContractResponseSchema = z.strictObject({
  contractVersion: z.literal(PLATFORM_CONTENT_CONTRACT_VERSION),
  operations: z.array(ContractOperationSchema).min(5),
  limits: z.strictObject({
    maxBatchItems: NonNegativeIntegerSchema,
    maxRequestBytes: NonNegativeIntegerSchema,
    maxBodyTextBytes: NonNegativeIntegerSchema,
    maxEvidenceTextBytes: NonNegativeIntegerSchema,
  }),
  errorCodes: z.array(PlatformContentErrorCodeSchema),
  sources: z.array(ContractSourceSchema),
  sourceNextCursor: z.string().trim().min(1).nullable(),
  examples: z.array(z.string().trim().min(1).max(1024)).max(64),
});
export type GetDataContractResponse = z.infer<typeof GetDataContractResponseSchema>;

export const SearchContentRequestSchema = z.strictObject({
  filters: z
    .strictObject({
      kind: ContentKindSchema.nullable().optional(),
      query: z.string().trim().min(1).max(1024).nullable().optional(),
      sourceKey: PublicIdSchema.nullable().optional(),
      publicationStatus: z.enum(["published", "withdrawn"]).nullable().optional(),
      caseNumber: z.string().trim().min(1).max(256).nullable().optional(),
    })
    .nullable()
    .optional(),
  cursor: z.string().trim().min(1).nullable().optional(),
  limit: NonNegativeIntegerSchema.min(1).max(100).default(20),
});
export type SearchContentRequest = z.infer<typeof SearchContentRequestSchema>;

export const ContentVersionSummarySchema = z.strictObject({
  versionId: PublicIdSchema,
  versionLabel: z.string().trim().min(1).max(256).nullable(),
  sourceKey: PublicIdSchema,
  sourceUrl: PlatformContentUrlSchema,
  publishedAt: PlatformContentTimestampSchema.nullable(),
  updatedAt: PlatformContentTimestampSchema.nullable(),
  bodyBytes: NonNegativeIntegerSchema,
  publicationStatus: z.enum(["published", "withdrawn"]),
});

export const SearchContentItemSchema = z.strictObject({
  itemId: PublicIdSchema,
  kind: ContentKindSchema,
  title: z.string().trim().min(1).max(4096),
  version: ContentVersionSummarySchema,
  legislation: LegislationMetadataSchema.partial().nullable().optional(),
  judgment: JudgmentMetadataSchema.partial().nullable().optional(),
  bodyText: z.string().nullable(),
});
export type SearchContentItem = z.infer<typeof SearchContentItemSchema>;

export const SearchContentResponseSchema = z.strictObject({
  items: z.array(SearchContentItemSchema),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type SearchContentResponse = z.infer<typeof SearchContentResponseSchema>;

export const SubmitBatchResponseSchema = z.strictObject({
  batchId: PublicIdSchema,
  receivedAt: PlatformContentTimestampSchema,
  status: z.enum(["received", "validating", "ready", "partially_validated", "rejected"]),
  entries: z.array(
    z.strictObject({
      entryKey: PublicIdSchema,
      status: z.enum(["accepted", "duplicate", "rejected"]),
      issues: z.array(PlatformContentIssueSchema),
    }),
  ),
});
export type SubmitBatchResponse = z.infer<typeof SubmitBatchResponseSchema>;

export const InspectBatchRequestSchema = z.strictObject({
  batchId: PublicIdSchema,
  cursor: z.string().trim().min(1).nullable().optional(),
  limit: NonNegativeIntegerSchema.min(1).max(100).default(20),
});
export type InspectBatchRequest = z.infer<typeof InspectBatchRequestSchema>;

export const InspectBatchResponseSchema = z.strictObject({
  batchId: PublicIdSchema,
  validationRevision: NonNegativeIntegerSchema,
  status: z.enum(["received", "validating", "ready", "partially_validated", "rejected", "published"]),
  entries: z.array(
    z.strictObject({
      entryKey: PublicIdSchema,
      operation: z.enum(["upsert", "withdraw", "restore"]),
      status: z.enum(["pending", "ready", "blocked", "published", "unchanged", "failed"]),
      issues: z.array(PlatformContentIssueSchema),
      diff: z.record(z.string(), z.unknown()).nullable().optional(),
      publicationStatus: z.enum(["published", "withdrawn"]).nullable().optional(),
    }),
  ),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type InspectBatchResponse = z.infer<typeof InspectBatchResponseSchema>;

export const PublishBatchRequestSchema = z.strictObject({
  batchId: PublicIdSchema,
  validationRevision: NonNegativeIntegerSchema,
  entryKeys: z.array(PublicIdSchema).min(1).max(PLATFORM_CONTENT_LIMITS.maxBatchItems),
  idempotencyKey: IdempotencyKeySchema,
});
export type PublishBatchRequest = z.infer<typeof PublishBatchRequestSchema>;

export const PublishBatchResponseSchema = z.strictObject({
  publicationId: PublicIdSchema,
  batchId: PublicIdSchema,
  status: z.enum(["completed", "partial", "pending", "failed"]),
  entries: z.array(
    z.strictObject({
      entryKey: PublicIdSchema,
      status: z.enum(["published", "unchanged", "blocked", "failed", "pending"]),
      versionId: PublicIdSchema.nullable(),
      issues: z.array(PlatformContentIssueSchema),
    }),
  ),
});
export type PublishBatchResponse = z.infer<typeof PublishBatchResponseSchema>;

export type PlatformContentToolContracts = {
  get_data_contract: {
    request: GetDataContractRequest;
    response: GetDataContractResponse;
  };
  search_content: { request: SearchContentRequest; response: SearchContentResponse };
  submit_batch: { request: IngestionBatch; response: SubmitBatchResponse };
  inspect_batch: { request: InspectBatchRequest; response: InspectBatchResponse };
  publish_batch: { request: PublishBatchRequest; response: PublishBatchResponse };
};
