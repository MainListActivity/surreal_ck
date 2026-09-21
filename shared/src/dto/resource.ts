import type { ISODateTimeString, RecordIdString } from "./transport";

// 资源库（resource_item / research_session）传输契约。表不带 workspace 字段，
// 隔离靠 workspace db 边界；`workspaceId` 仅作调用方上下文透传，服务端不据此过滤。

export type ResourceQuality = "user-confirmed" | "ai-draft" | "imported" | "deprecated";
export type ResearchSessionStatus = "open" | "completed" | "cancelled";
export type ResourceEmbeddingStatus = "disabled" | "pending" | "indexed" | "failed" | "stale";

export type ResourceEvidenceDTO = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
  capturedAt: ISODateTimeString;
  order: number;
};

export type ResourceDTO = {
  id: RecordIdString;
  workspaceId?: RecordIdString;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidenceDTO[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  /** 最近一条把该资源计入 created_resources 的 research_session。 */
  researchSessionId?: RecordIdString;
  createdBy?: RecordIdString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
};

/** 引用回答只依赖的资源子集；平台法律库条目也按此形状投影。 */
export type CitableResource = Pick<
  ResourceDTO,
  "id" | "resourceType" | "title" | "summary" | "sourceUrl" | "sourceTitle" | "evidence"
> & Partial<Pick<ResourceDTO, "structuredPayload">>;

export type ResearchSessionDTO = {
  id: RecordIdString;
  workspaceId?: RecordIdString;
  originatingRunId?: string;
  query: string;
  context: Record<string, unknown>;
  resourceType: string;
  status: ResearchSessionStatus;
  resourceIds: RecordIdString[];
  createdBy?: RecordIdString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
  cancelledAt?: ISODateTimeString;
};

export type SaveResourceRequest = {
  workspaceId: RecordIdString;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidenceDTO[];
  tags?: string[];
  structuredPayload?: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  researchSessionId?: RecordIdString;
};

export type GetResourceDetailRequest = {
  resourceId: RecordIdString;
};

export type ResourceDetailResponse = {
  resource: ResourceDTO;
};

export type ResourceSearchContext = {
  selectedRow?: {
    id?: string;
    label?: string;
    visibleValues?: Record<string, unknown>;
  } | Record<string, unknown> | null;
  document?: {
    title?: string;
    text?: string;
  } | string;
  manualText?: string;
};

export type ResourceSearchFilters = {
  tags?: string[];
  sourceDomain?: string;
  dateFrom?: ISODateTimeString;
  dateTo?: ISODateTimeString;
};

export type ResourceSearchStatus = "hit" | "candidates" | "miss";
export type ResourceSearchIndexStatus = "ready" | "index-disabled" | "index-pending" | "index-error";

export type SearchResourcesRequest = {
  workspaceId?: RecordIdString;
  query: string;
  context?: ResourceSearchContext;
  resourceType?: string;
  filters?: ResourceSearchFilters;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
};

export type ResourceSearchResultDTO = {
  resource: ResourceDTO;
  score: number;
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
};

export type SearchResourcesResponse = {
  status: ResourceSearchStatus;
  indexStatus: ResourceSearchIndexStatus;
  queryText: string;
  results: ResourceSearchResultDTO[];
};

export type CreateResearchSessionRequest = {
  workspaceId?: RecordIdString;
  query: string;
  context?: Record<string, unknown>;
  resourceType: string;
  originatingRunId?: string;
};

export type ResearchSessionResponse = {
  session: ResearchSessionDTO;
};
