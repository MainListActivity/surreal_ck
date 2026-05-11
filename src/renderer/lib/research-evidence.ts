import type { ResourceEvidenceDTO } from "../../shared/rpc.types";

export type EvidenceDraftInput = Omit<ResourceEvidenceDTO, "order"> & {
  order?: number;
};

export function createEvidenceFromPaste(input: Required<Pick<ResourceEvidenceDTO, "text" | "capturedAt" | "order">> & {
  sourceUrl?: string;
  sourceTitle?: string;
}): ResourceEvidenceDTO {
  return {
    text: input.text.trim(),
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    capturedAt: input.capturedAt,
    order: input.order,
  };
}

export function addEvidenceSnippet(
  current: ResourceEvidenceDTO[],
  input: EvidenceDraftInput,
): ResourceEvidenceDTO[] {
  const next: ResourceEvidenceDTO = {
    text: input.text.trim(),
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    capturedAt: input.capturedAt,
    order: current.length,
  };
  return [...current, next];
}

export function removeEvidenceSnippet(
  current: ResourceEvidenceDTO[],
  order: number,
): ResourceEvidenceDTO[] {
  return renumberEvidence(current.filter((item) => item.order !== order));
}

export function renumberEvidence(items: ResourceEvidenceDTO[]): ResourceEvidenceDTO[] {
  return items.map((item, index) => ({ ...item, order: index }));
}
