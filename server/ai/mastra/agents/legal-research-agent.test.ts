import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import type { ResourceDTO, SearchResourcesRequest, SearchResourcesResponse } from "@surreal-ck/shared/dto";
import { makeLegalResearchExecutor, type ResearchAnswerModel } from "./legal-research-agent";
import type { ContentResearchWindow } from "../../../src/research/window";

const digest = createHash("sha256").update("现行正文").digest("hex");

/** 授权内语料：带唯一标记 CANARY-AUTHORIZED；授权外语料：CANARY-DENIED（绝不允许进入提示词/回答）。 */
const AUTH_QUOTE = "第一条 合同自成立时生效。（CANARY-AUTHORIZED）";
const PRIVATE_QUOTE = "法院认为解除通知到达后合同解除。（CANARY-PRIVATE）";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

function fakeContentSession(): Pick<Surreal, "query"> {
  const query = (sql: string): Promise<unknown> => {
    if (sql.includes("content_search_facet")) {
      return Promise.resolve([[
        { id: "facet:a", version_id: "content_version:v-auth", public_id: "a-v1", title: "甲法", kind: "legislation", source_url: "https://example.invalid/a", version_label: "2026 修订", published_on: "2026-01-01" },
        { id: "facet:b", version_id: "content_version:v-denied", public_id: "b-v1", title: "乙法", kind: "legislation", source_url: "https://example.invalid/b", version_label: null, published_on: "2026-01-02" },
      ]]);
    }
    if (sql.includes("content_read_gate")) {
      return Promise.resolve([[
        { version: "content_version:v-auth", actions: ["browse", "search", "read", "cite"], ai_actions: ["research"], license_actions: ["browse", "search", "read", "cite", "research"] },
        // 授权外候选：无本人 gate —— fail closed（现实中库层也不会给这行）。
        { version: "content_version:v-denied", actions: [], ai_actions: [], license_actions: [] },
      ]]);
    }
    if (sql.includes("legal_article_version")) {
      return Promise.resolve([[{ local_key: "art-1", label: "第一条", body_text: AUTH_QUOTE, locator: { start: 0, end: 10, bodyDigest: digest } }]]);
    }
    if (sql.includes("content_citation")) return Promise.resolve([[]]);
    if (sql.includes("FROM content_version")) {
      return Promise.resolve([[{ id: "content_version:v-auth", item: "content_item:i-auth", public_id: "a-v1", title: "甲法", body_text: "现行正文", body_sha256: digest, source_key: "s", source_url: "https://example.invalid/a" }]]);
    }
    return Promise.resolve([[]]);
  };
  return { query } as unknown as Pick<Surreal, "query">;
}

let closeCount = 0;
function readyWindow(): ContentResearchWindow {
  return {
    kind: "ready",
    session: fakeContentSession(),
    namespace: "main",
    database: "platform_content",
    entitlementRevision: "7",
    digest: "sha256:abc",
    leaseEndSeconds: Math.floor(Date.now() / 1000) + 600,
    close: () => {
      closeCount += 1;
      return Promise.resolve();
    },
  };
}

const privateResource: ResourceDTO = {
  id: "resource_item:r1",
  workspaceId: "workspace:demo",
  resourceType: "generic_note",
  title: "案件笔记",
  summary: "解除效力笔记",
  sourceUrl: "https://example.com/note",
  evidence: [
    { text: PRIVATE_QUOTE, sourceUrl: "https://example.com/note", sourceTitle: "笔记", capturedAt: "2026-05-11T08:00:00.000Z", order: 0 },
  ],
  tags: [],
  structuredPayload: {},
  quality: "user-confirmed",
  createdAt: "2026-05-11T08:00:00.000Z",
  updatedAt: "2026-05-11T08:00:00.000Z",
};

function hitResponse(status: "hit" | "candidates" = "hit"): SearchResourcesResponse {
  return {
    status,
    indexStatus: "index-disabled",
    queryText: "q",
    results: [{ resource: privateResource, score: status === "hit" ? 0.9 : 0.4, vectorScore: 0, keywordScore: 0.7, qualityScore: 1, recencyScore: 1 }],
  };
}

function executorWith(input: {
  window?: ContentResearchWindow | Error;
  search?: SearchResourcesResponse;
  model?: (prompt: string) => Promise<string> | string;
}) {
  const prompts: string[] = [];
  const model: ResearchAnswerModel = async (prompt) => {
    prompts.push(prompt);
    if (!input.model) return "根据证据 [1] 与 [2] 得出结论。";
    return await input.model(prompt);
  };
  const executor = makeLegalResearchExecutor({
    resolveWorkspaceId: async () => "ws_demo",
    searchResources: (async () => input.search ?? {
      status: "miss",
      indexStatus: "index-disabled",
      queryText: "q",
      results: [],
    }) as unknown as (req: SearchResourcesRequest, session?: Surreal) => Promise<SearchResourcesResponse>,
    answerModel: model,
  });
  return { executor, prompts };
}

function run(executor: ReturnType<typeof makeLegalResearchExecutor>, openContentSession?: () => Promise<ContentResearchWindow>) {
  return executor({
    taskText: "合同什么时候生效？",
    shared: { userContext: emptyContext, confirmed: {} },
    runId: "run-1",
    surrealSession: undefined,
    openContentSession,
  });
}

describe("legal research executor", () => {
  test("联合平台与私有材料：提示词只含登记证据，引用只含登记句柄，窗口用后即关", async () => {
    closeCount = 0;
    const { executor, prompts } = executorWith({
      window: readyWindow(),
      search: hitResponse(),
    });
    const out = await run(executor, () => Promise.resolve(readyWindow()));

    // 提示词：授权语料与私有材料都在；授权外唯一标记绝不出现。
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("CANARY-AUTHORIZED");
    expect(prompts[0]).toContain("CANARY-PRIVATE");
    expect(prompts[0]).not.toContain("CANARY-DENIED");

    // 回答文本：来源事实 / 用户材料 / 模型分析 三段区分；授权外内容不出现。
    expect(out.text).toContain("【来源事实】");
    expect(out.text).toContain("【用户材料】");
    expect(out.text).toContain("【模型分析】");
    expect(out.text).toContain("CANARY-AUTHORIZED");
    expect(out.text).not.toContain("CANARY-DENIED");

    // 引用快照：平台项带精确版本与定位。
    expect(out.citations).toHaveLength(2);
    const platform = out.citations!.find((c) => c.platformContent !== undefined);
    expect(platform).toMatchObject({
      resourceId: "content_item:i-auth",
      platformContent: {
        versionId: "content_version:v-auth",
        locator: { start: 0, end: 10, bodyDigest: digest },
      },
    });
    expect(out.suspend).toBeUndefined();
    expect(closeCount).toBe(1);
  });

  test("伪造句柄被后处理剔除并在覆盖说明中披露", async () => {
    const { executor, prompts } = executorWith({
      window: readyWindow(),
      model: () => "结论 [1]；伪造 [9]。",
    });
    const out = await run(executor, () => Promise.resolve(readyWindow()));
    expect(prompts[0]).toContain("[1]");
    expect(out.citations).toHaveLength(1);
    expect(out.citations![0]!.index).toBe(1);
    expect(out.text).toContain("引用 [9] 未通过核验（句柄未登记），已从引用中移除。");
    expect(out.text).toContain("【覆盖说明】");
  });

  test("平台不可用：降级为私有资料分析并显式标注 partial", async () => {
    const { executor, prompts } = executorWith({
      window: { kind: "unavailable", reason: "entitlement_absent" },
      search: hitResponse(),
    });
    const out = await run(executor, () => Promise.resolve({ kind: "unavailable", reason: "entitlement_absent" }));
    expect(prompts[0]).toContain("平台语料当前不可用（unavailable）");
    expect(prompts[0]).not.toContain("CANARY-AUTHORIZED");
    expect(out.text).toContain("【覆盖说明】");
    expect(out.text).toContain("仅基于工作区私有资料（partial）");
    expect(out.text).toContain("CANARY-PRIVATE");
    expect(out.citations).toHaveLength(1);
    expect(out.citations![0]!.platformContent).toBeUndefined();
  });

  test("openContentSession 未注入：不做平台语料研究，私有材料继续可用", async () => {
    const { executor, prompts } = executorWith({ search: hitResponse() });
    const out = await run(executor);
    expect(prompts[0]).toContain("平台语料当前不可用（unavailable）");
    expect(out.text).toContain("partial");
    expect(out.citations).toHaveLength(1);
  });

  test("openContentSession 抛错：按平台不可用降级，不中断 run", async () => {
    const { executor, prompts } = executorWith({
      window: new Error("window open failed"),
      search: hitResponse(),
    });
    const out = await run(executor, () => Promise.reject(new Error("window open failed")));
    expect(prompts[0]).toContain("平台语料当前不可用（unavailable）");
    expect(out.text).toContain("partial");
  });

  test("双语料皆空：只说明缺口，不调用模型", async () => {
    const modelCalls: string[] = [];
    const executor = makeLegalResearchExecutor({
      resolveWorkspaceId: async () => "ws_demo",
      searchResources: (async () => ({ status: "miss", indexStatus: "index-disabled", queryText: "q", results: [] })) as unknown as (req: SearchResourcesRequest, session?: Surreal) => Promise<SearchResourcesResponse>,
      answerModel: async (prompt) => {
        modelCalls.push(prompt);
        return "不应被调用";
      },
    });
    const out = await run(executor, () => Promise.resolve({ kind: "empty" }));
    expect(modelCalls).toHaveLength(0);
    expect(out.text).toContain("未登记到任何可用证据；本回答不构成有来源的法律结论");
    expect(out.text).toContain("平台语料当前没有可授权集合");
    expect(out.citations).toBeUndefined();
  });

  test("平台无证据 + 私有候选：挂起 payload 只含工作区资源，平台证据不进入挂起状态", async () => {
    const { executor } = executorWith({
      window: { kind: "unavailable", reason: "platform_error" },
      search: hitResponse("candidates"),
    });
    const out = await run(executor, () => Promise.resolve({ kind: "unavailable", reason: "platform_error" }));
    expect(out.suspend?.kind).toBe("resource-candidates");
    const candidates = (out.suspend as { candidates: Array<{ id: string }> }).candidates;
    expect(candidates.map((c) => c.id)).toEqual(["resource_item:r1"]);
  });

  test("模型失败：登记证据仍在，回答不含编造分析", async () => {
    const { executor } = executorWith({
      window: readyWindow(),
      model: () => {
        throw new Error("model down");
      },
    });
    const out = await run(executor, () => Promise.resolve(readyWindow()));
    expect(out.text).toContain("模型分析暂不可用");
    expect(out.citations).toBeUndefined();
    expect(out.text).toContain("CANARY-AUTHORIZED");
  });
});
