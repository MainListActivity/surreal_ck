import { describe, expect, test } from "bun:test";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import type { ResourceDTO } from "./resource-agent";
import {
  answerSelectedResourceIds,
  createResourceCitationAnswer,
  createResourceDraftFromEvidence,
  makeResourceRetrievalExecutor,
} from "./resource-agent";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

const resource: ResourceDTO = {
  id: "resource_item:r1",
  workspaceId: "workspace:demo",
  resourceType: "generic_note",
  title: "合同解除案例",
  summary: "法院认为解除通知到达后合同解除发生效力。",
  sourceUrl: "https://example.com/case",
  sourceTitle: "案例来源",
  evidence: [
    {
      text: "解除通知到达相对方后产生解除效力。",
      sourceUrl: "https://example.com/case",
      sourceTitle: "案例来源",
      capturedAt: "2026-05-11T08:00:00.000Z",
      order: 0,
    },
  ],
  tags: ["合同"],
  structuredPayload: {},
  quality: "user-confirmed",
  duplicateHashes: { content: "c", evidence: "e", source: "s" },
  embedding: { status: "indexed" },
  createdBy: "app_user:u1",
  createdAt: "2026-05-11T08:00:00.000Z",
  updatedAt: "2026-05-11T08:00:00.000Z",
};

describe("resource retrieval executor", () => {
  test("高置信命中时生成带文本引用和结构化 citations 的回答", async () => {
    const answer = createResourceCitationAnswer({
      question: "查找合同解除案例",
      resources: [resource],
    });

    expect(answer.text).toContain("[1]");
    expect(answer.citations).toEqual([
      {
        index: 1,
        resourceId: "resource_item:r1",
        title: "合同解除案例",
        sourceUrl: "https://example.com/case",
        evidence: [{ order: 0, text: "解除通知到达相对方后产生解除效力。" }],
      },
    ]);
  });

  test("executor 高置信 hit 直接返回 citation answer", async () => {
    const executor = makeResourceRetrievalExecutor({
      resolveWorkspaceId: async () => "workspace:demo",
      searchResources: async () => ({
        status: "hit",
        indexStatus: "ready",
        queryText: "查找合同解除案例",
        results: [{
          resource,
          score: 0.92,
          vectorScore: 0.8,
          keywordScore: 0.6,
          qualityScore: 1,
          recencyScore: 1,
        }],
      }),
    });

    const out = await executor({
      taskText: "查找合同解除案例",
      shared: { userContext: emptyContext, confirmed: {} },
      runId: "run-1",
    });

    expect(out.text).toContain("[1]");
    expect(out.citations?.[0]?.resourceId).toBe("resource_item:r1");
    expect(out.suspend).toBeUndefined();
  });

  test("executor 中置信 candidates 返回资源候选 suspend payload", async () => {
    const executor = makeResourceRetrievalExecutor({
      resolveWorkspaceId: async () => "workspace:demo",
      searchResources: async () => ({
        status: "candidates",
        indexStatus: "ready",
        queryText: "查找合同解除案例",
        results: [{
          resource,
          score: 0.42,
          vectorScore: 0.4,
          keywordScore: 0.3,
          qualityScore: 1,
          recencyScore: 1,
        }],
      }),
    });

    const out = await executor({
      taskText: "查找合同解除案例",
      shared: { userContext: emptyContext, confirmed: {} },
      runId: "run-1",
    });

    expect(out.suspend).toEqual({
      kind: "resource-candidates",
      candidates: [{
        id: "resource_item:r1",
        label: "合同解除案例",
        summary: "法院认为解除通知到达后合同解除发生效力。",
        score: 0.42,
        resourceType: "generic_note",
        sourceUrl: "https://example.com/case",
      }],
    });
    expect(out.citations).toBeUndefined();
  });

  test("executor 对索引不可用状态给出明确说明", async () => {
    const executor = makeResourceRetrievalExecutor({
      resolveWorkspaceId: async () => "workspace:demo",
      searchResources: async () => ({
        status: "miss",
        indexStatus: "index-error",
        queryText: "查找合同解除案例",
        results: [],
      }),
    });

    const out = await executor({
      taskText: "查找合同解除案例",
      shared: { userContext: emptyContext, confirmed: {} },
      runId: "run-1",
    });

    expect(out.text).toContain("语义索引存在失败状态");
    expect(out.suspend).toBeUndefined();
  });

  test("executor 低置信 miss 创建 research session 并进入 manual research suspend", async () => {
    const created: Array<{ workspaceId: string; query: string; resourceType: string; originatingRunId?: string }> = [];
    const executor = makeResourceRetrievalExecutor({
      resolveWorkspaceId: async () => "workspace:demo",
      searchResources: async () => ({
        status: "miss",
        indexStatus: "ready",
        queryText: "查找合同解除案例",
        results: [],
      }),
      createResearchSession: async (req) => {
        created.push(req);
        return {
          session: {
            id: "research_session:s1",
            workspaceId: req.workspaceId,
            query: req.query,
            context: req.context ?? {},
            resourceType: req.resourceType,
            status: "open",
            resourceIds: [],
            createdBy: "app_user:u1",
            createdAt: "2026-05-11T08:00:00.000Z",
            updatedAt: "2026-05-11T08:00:00.000Z",
          },
        };
      },
    });

    const out = await executor({
      taskText: "查找合同解除案例",
      shared: { userContext: emptyContext, confirmed: {} },
      runId: "run-1",
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workspaceId: "workspace:demo",
      query: "查找合同解除案例",
      resourceType: "generic_note",
      originatingRunId: "run-1",
    });
    expect(out.suspend).toEqual({
      kind: "manual-research",
      sessionId: "research_session:s1",
      workspaceId: "workspace:demo",
      query: "查找合同解除案例",
      resourceType: "generic_note",
    });
  });

  test("answerSelectedResourceIds 只接收 resourceIds 并回查资源详情生成回答", async () => {
    const seenIds: string[] = [];
    const answer = await answerSelectedResourceIds({
      question: "查找合同解除案例",
      resourceIds: ["resource_item:r1"],
      getResourceDetail: async ({ resourceId }) => {
        seenIds.push(resourceId);
        return { resource };
      },
    });

    expect(seenIds).toEqual(["resource_item:r1"]);
    expect(answer.text).toContain("[1]");
    expect(answer.citations[0]?.resourceId).toBe("resource_item:r1");
  });

  test("createResourceDraftFromEvidence 根据证据篮生成 resource draft", () => {
    const draft = createResourceDraftFromEvidence({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      evidence: resource.evidence,
    });

    expect(draft).toMatchObject({
      workspaceId: "workspace:demo",
      resourceType: "generic_note",
      title: "案例来源",
      summary: "解除通知到达相对方后产生解除效力。",
      sourceUrl: "https://example.com/case",
      sourceTitle: "案例来源",
      structuredPayload: {},
      quality: "ai-draft",
    });
    expect(draft.evidence).toEqual(resource.evidence);
  });

  test("createResourceDraftFromEvidence 将证据篮映射为 web_article 草稿字段", () => {
    const draft = createResourceDraftFromEvidence({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      evidence: resource.evidence,
    });

    expect(draft).toMatchObject({
      workspaceId: "workspace:demo",
      resourceType: "web_article",
      title: "案例来源",
      summary: "解除通知到达相对方后产生解除效力。",
      sourceUrl: "https://example.com/case",
      sourceTitle: "案例来源",
      structuredPayload: {
        siteName: "案例来源",
      },
      quality: "ai-draft",
    });
  });
});
