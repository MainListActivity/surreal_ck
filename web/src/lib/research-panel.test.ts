import { describe, expect, test } from "bun:test";
import type { ResearchSaveEvent } from "@surreal-ck/shared";
import { createResearchPanelSession, type ResearchPanelOptions } from "./research-panel";

const context = {
  sessionId: "research_session:s1",
  runId: "run-1",
  query: "合同无效再审案例",
  resourceType: "generic_note",
  recordId: "ent_claim:c1",
};

function makeSession(overrides: Partial<ResearchPanelOptions> = {}) {
  const saveCalls: unknown[] = [];
  const associationCalls: Array<{ resourceId: string; recordId: string }> = [];
  const finishCalls: Array<{ sessionId: string; runId?: string; resourceIds: string[] }> = [];
  let saveScript: ResearchSaveEvent[][] = [
    [
      { kind: "validating" },
      { kind: "embedding", status: "disabled" },
      { kind: "persisting" },
      { kind: "session-updated", sessionId: context.sessionId, resourceId: "resource_item:r1" },
      { kind: "done", resourceId: "resource_item:r1", embeddingStatus: "disabled" },
    ],
  ];

  const session = createResearchPanelSession({
    context,
    saveAction: async (request, onEvent) => {
      saveCalls.push(request);
      const events = saveScript.shift() ?? [];
      for (const event of events) onEvent(event);
    },
    finishAction: async (input) => {
      finishCalls.push(input);
    },
    associationAction: async (input) => {
      associationCalls.push(input);
    },
    now: () => "2026-06-11T08:00:00.000Z",
    ...overrides,
  });

  return {
    session,
    saveCalls,
    associationCalls,
    finishCalls,
    setSaveScript(scripts: ResearchSaveEvent[][]) {
      saveScript = scripts;
    },
  };
}

describe("research panel session", () => {
  test("证据篮：粘贴即记录 capturedAt/order，删除后顺序重排", () => {
    const { session } = makeSession();

    session.addEvidence({ text: "第一段", sourceUrl: "https://a.example/1", sourceTitle: "来源A" });
    session.addEvidence({ text: "第二段" });
    session.addEvidence({ text: "第三段" });

    let state = session.snapshot();
    expect(state.evidence.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(state.evidence[0]).toMatchObject({
      text: "第一段",
      sourceUrl: "https://a.example/1",
      sourceTitle: "来源A",
      capturedAt: "2026-06-11T08:00:00.000Z",
    });

    session.removeEvidence(1);
    state = session.snapshot();
    expect(state.evidence.map((item) => item.text)).toEqual(["第一段", "第三段"]);
    expect(state.evidence.map((item) => item.order)).toEqual([0, 1]);
  });

  test("保存成功：进度按事件推进，done 后记录资源 id 并清空草稿/证据篮准备下一个资源", async () => {
    const progressTrail: string[] = [];
    const { session, saveCalls } = makeSession({
      onChange: (state) => progressTrail.push(state.saveProgress),
    });

    session.addEvidence({ text: "证据一" });
    session.updateDraft({ title: "标题", summary: "摘要" });
    await session.save();

    const state = session.snapshot();
    expect(state.savedResourceIds).toEqual(["resource_item:r1"]);
    expect(state.evidence).toEqual([]);
    expect(state.draft.title).toBe("");
    expect(state.saveProgress).toBe("idle");
    expect(state.saveError).toBeNull();
    expect(progressTrail).toContain("embedding");
    expect(progressTrail).toContain("persisting");

    const sent = saveCalls[0] as { sessionId: string; draft: { evidence: unknown[] } };
    expect(sent.sessionId).toBe(context.sessionId);
    expect(sent.draft.evidence).toHaveLength(1);
  });

  test("保存到当前选中记录：资源落库后使用当前 workspace session 建立关联", async () => {
    const { session, associationCalls } = makeSession();
    session.addEvidence({ text: "借款合同载明本金 100 万元" });
    session.updateDraft({ title: "借款合同摘要", summary: "合同本金与期限摘要" });

    await session.save();

    expect(associationCalls).toEqual([{
      resourceId: "resource_item:r1",
      recordId: "ent_claim:c1",
    }]);
    expect(session.snapshot().associatedResourceIds).toEqual(["resource_item:r1"]);
  });

  test("当前记录可查看全部关联资源，并只解除关联而不删除资源", async () => {
    const unlinkCalls: string[] = [];
    const { session } = makeSession({
      loadAssociationsAction: async () => [
        {
          linkId: "resource_record_link:l1",
          resourceId: "resource_item:r1",
          title: "网页判例",
          summary: "判例摘要",
          sourceUrl: "https://example.test/case",
        },
        {
          linkId: "resource_record_link:l2",
          resourceId: "resource_item:r2",
          title: "人工摘要",
          summary: "人工整理",
        },
      ],
      unlinkAction: async (linkId) => {
        unlinkCalls.push(linkId);
      },
    });

    await session.loadAssociations();
    expect(session.snapshot().relatedResources.map((item) => item.title)).toEqual([
      "网页判例",
      "人工摘要",
    ]);

    await session.unlink("resource_record_link:l1");
    expect(unlinkCalls).toEqual(["resource_record_link:l1"]);
    expect(session.snapshot().relatedResources.map((item) => item.resourceId)).toEqual([
      "resource_item:r2",
    ]);
  });

  test("保存失败（SSE error）：草稿与证据篮原样保留，可再次保存成功", async () => {
    const { session, setSaveScript, saveCalls } = makeSession();
    setSaveScript([
      [{ kind: "validating" }, { kind: "error", stage: "embedding", message: "provider 503" }],
      [
        { kind: "validating" },
        { kind: "embedding", status: "generating" },
        { kind: "persisting" },
        { kind: "session-updated", sessionId: context.sessionId, resourceId: "resource_item:r2" },
        { kind: "done", resourceId: "resource_item:r2", embeddingStatus: "indexed" },
      ],
    ]);

    session.addEvidence({ text: "证据一", sourceUrl: "https://a.example/1" });
    session.updateDraft({ title: "标题", summary: "摘要" });

    await session.save();
    let state = session.snapshot();
    expect(state.saveError).toEqual({ stage: "embedding", message: "provider 503" });
    expect(state.evidence).toHaveLength(1);
    expect(state.draft.title).toBe("标题");
    expect(state.canSave).toBe(true);

    await session.save();
    state = session.snapshot();
    expect(state.saveError).toBeNull();
    expect(state.savedResourceIds).toEqual(["resource_item:r2"]);
    expect(saveCalls).toHaveLength(2);
  });

  test("本地预校验失败（缺标题）：不触发网络保存，错误标在 validating", async () => {
    const { session, saveCalls } = makeSession();
    session.addEvidence({ text: "证据一" });

    await session.save();

    const state = session.snapshot();
    expect(saveCalls).toHaveLength(0);
    expect(state.saveError?.stage).toBe("validating");
    expect(state.evidence).toHaveLength(1);
  });

  test("完成检索：保存过资源才可完成；finishAction 带 sessionId/runId/全部资源 id", async () => {
    const { session, finishCalls, setSaveScript } = makeSession();
    expect(session.snapshot().canFinish).toBe(false);
    await session.finish();
    expect(finishCalls).toHaveLength(0);

    setSaveScript([
      [{ kind: "done", resourceId: "resource_item:r1", embeddingStatus: "disabled" }],
      [{ kind: "done", resourceId: "resource_item:r2", embeddingStatus: "disabled" }],
    ]);
    for (const title of ["资源一", "资源二"]) {
      session.addEvidence({ text: `${title}的证据` });
      session.updateDraft({ title, summary: "摘要" });
      await session.save();
    }

    expect(session.snapshot().canFinish).toBe(true);
    await session.finish();

    expect(finishCalls).toEqual([
      {
        sessionId: context.sessionId,
        runId: "run-1",
        resourceIds: ["resource_item:r1", "resource_item:r2"],
      },
    ]);
    const state = session.snapshot();
    expect(state.finished).toBe(true);
    expect(state.canSave).toBe(false);
  });

  test("完成检索失败：finishError 可见、finished 保持 false 可重试", async () => {
    const { session, setSaveScript } = makeSession({
      finishAction: async () => {
        throw new Error("resume 504");
      },
    });
    setSaveScript([[{ kind: "done", resourceId: "resource_item:r1", embeddingStatus: "disabled" }]]);
    session.addEvidence({ text: "证据" });
    session.updateDraft({ title: "标题", summary: "摘要" });
    await session.save();

    await session.finish();

    const state = session.snapshot();
    expect(state.finishError).toBe("resume 504");
    expect(state.finished).toBe(false);
    expect(state.canFinish).toBe(true);
  });
});
