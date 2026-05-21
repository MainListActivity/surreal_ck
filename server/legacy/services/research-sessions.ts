import { ServiceError } from "./errors";
import type { ResearchSessionRow } from "./resources";

type RecordRef = ResearchSessionRow["id"] | string;

export type PrivateResearchSessionRepository = {
  findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null>;
  updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null>;
  linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void>;
  findResearchSessionIdByResource(resourceId: string): Promise<string | null>;
};

export async function loadOpenResearchSessionForResource(
  repository: Pick<PrivateResearchSessionRepository, "findResearchSessionById">,
  sessionId: string,
  workspaceId: string,
): Promise<ResearchSessionRow> {
  const session = await repository.findResearchSessionById(sessionId);
  if (!session) throw new ServiceError("NOT_FOUND", "检索会话不存在");
  if (String(session.workspace) !== workspaceId) {
    throw new ServiceError("VALIDATION_ERROR", "资源与检索会话不属于同一工作区");
  }
  if (session.status !== "open") {
    throw new ServiceError("VALIDATION_ERROR", "只能向 open 状态的检索会话保存资源");
  }
  return session;
}

export async function linkPublishedResourceToOpenSession(
  repository: Pick<PrivateResearchSessionRepository, "linkResourceToResearchSession" | "updateResearchSession">,
  input: {
    session: ResearchSessionRow;
    resourceId: RecordRef;
    timestamp: Date;
  },
): Promise<ResearchSessionRow> {
  await repository.linkResourceToResearchSession(String(input.resourceId), String(input.session.id));
  const updated = await repository.updateResearchSession(String(input.session.id), {
    created_resources: uniqueRecordRefs([...input.session.created_resources, input.resourceId]),
    updated_at: input.timestamp,
  });
  if (!updated) throw new ServiceError("NOT_FOUND", "检索会话不存在");
  return updated;
}

export function researchSessionSummary(row: ResearchSessionRow): {
  id: string;
  status: ResearchSessionRow["status"];
  query: string;
  resourceIds: string[];
} {
  return {
    id: String(row.id),
    status: row.status,
    query: row.query,
    resourceIds: row.created_resources.map(String),
  };
}

function uniqueRecordRefs(values: RecordRef[]): RecordRef[] {
  const seen = new Set<string>();
  const result: RecordRef[] = [];
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
