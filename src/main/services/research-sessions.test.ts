import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  linkPublishedResourceToOpenSession,
  loadOpenResearchSessionForResource,
  type PrivateResearchSessionRepository,
} from "./research-sessions";
import type { ResearchSessionRow } from "./resources";

class MemoryPrivateResearchSessionRepository implements PrivateResearchSessionRepository {
  readonly sessions = new Map<string, ResearchSessionRow>();
  readonly links = new Map<string, string>();

  async findResearchSessionById(sessionId: string): Promise<ResearchSessionRow | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async updateResearchSession(
    sessionId: string,
    patch: Partial<Omit<ResearchSessionRow, "id">>,
  ): Promise<ResearchSessionRow | null> {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.sessions.set(sessionId, next);
    return next;
  }

  async linkResourceToResearchSession(resourceId: string, sessionId: string): Promise<void> {
    this.links.set(resourceId, sessionId);
  }

  async findResearchSessionIdByResource(resourceId: string): Promise<string | null> {
    return this.links.get(resourceId) ?? null;
  }
}

function openSession(): ResearchSessionRow {
  return {
    id: new RecordId("research_session", "s1"),
    workspace: new RecordId("workspace", "demo"),
    query: "查找相似案例",
    context: {},
    resource_type: "generic_note",
    status: "open",
    created_resources: [],
    created_by: new RecordId("app_user", "u1"),
    created_at: new Date("2026-05-11T07:00:00.000Z"),
    updated_at: new Date("2026-05-11T07:00:00.000Z"),
  };
}

describe("private research sessions", () => {
  test("发布到共享资源库后，只在本地私有关联里记录 research session", async () => {
    const repo = new MemoryPrivateResearchSessionRepository();
    const session = openSession();
    repo.sessions.set(String(session.id), session);

    const loaded = await loadOpenResearchSessionForResource(repo, String(session.id), "workspace:demo");
    const updated = await linkPublishedResourceToOpenSession(repo, {
      session: loaded,
      resourceId: "resource_item:r1",
      timestamp: new Date("2026-05-11T08:00:00.000Z"),
    });

    expect(updated.created_resources.map(String)).toEqual(["resource_item:r1"]);
    expect(updated.updated_at).toEqual(new Date("2026-05-11T08:00:00.000Z"));
    expect(await repo.findResearchSessionIdByResource("resource_item:r1")).toBe(String(session.id));
  });
});
