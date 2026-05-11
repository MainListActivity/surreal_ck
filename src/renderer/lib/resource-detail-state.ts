import type { ResourceDTO, ResourceEmbeddingStatus } from "../../shared/rpc.types";

export function canRetryResourceEmbedding(status: ResourceEmbeddingStatus): boolean {
  return status === "failed" || status === "stale";
}

export function resourceDetailSourceLabel(resource: Pick<ResourceDTO, "sourceTitle" | "sourceUrl">): string {
  return resource.sourceTitle ?? resource.sourceUrl ?? "未记录来源";
}

export function formatStructuredPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}
