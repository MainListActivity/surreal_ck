import { test, expect } from "bun:test";
import type { CitationStatusEntry, ResourceCitationDTO } from "@surreal-ck/shared";
import {
  citableCitations,
  citationProbeKey,
  createCitationStatusStore,
  loadCitationStatuses,
  rerunQuestionFor,
  summarizeCitationStates,
} from "./citation-status";

const verifiable: CitationStatusEntry = {
  index: 1, versionPublicId: "a-v1", state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: true,
};
const locked: CitationStatusEntry = {
  index: 2, versionPublicId: "b-v1", state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: true,
};
const tombstoned: CitationStatusEntry = {
  index: 3, versionPublicId: "c-v1", state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false,
};

const citation = (index: number, versionPublicId: string, captureEntitlementRevision?: string): ResourceCitationDTO => ({
  index, title: `t${index}`, resourceId: "content_item:x",
  platformContent: {
    itemId: "content_item:x", versionId: "content_version:x", versionPublicId, sourceKey: "s", locator: null,
    ...(captureEntitlementRevision ? { entitlementRevision: captureEntitlementRevision } : {}),
  },
});

test("探针抽取：按（版本, 捕获依据）去重并跳过缺失 versionPublicId 的历史指针", () => {
  const citations = [citation(1, "a-v1"), citation(2, "a-v1"), citation(3, "b-v1", "7"), citation(4, "b-v1"), {
    index: 5, title: "t5", resourceId: "resource_item:x", platformContent: {
      itemId: "content_item:x", versionId: "content_version:x", sourceKey: "s", locator: null,
    },
  } as unknown as ResourceCitationDTO];
  expect(citableCitations(citations)).toEqual([
    { versionPublicId: "a-v1" },
    { versionPublicId: "b-v1", captureEntitlementRevision: "7" },
    { versionPublicId: "b-v1" },
  ]);
});

test("状态加载：按探针回填（含捕获依据）；请求失败 fail closed 全部不可用", async () => {
  const fetchImpl = (_input: string | URL): Promise<Response> => Promise.reject(new Error("down"));
  const statuses = await loadCitationStatuses(
    [{ versionPublicId: "a-v1" }, { versionPublicId: "b-v1", captureEntitlementRevision: "7" }],
    { fetchImpl, getToken: () => null },
  );
  expect(statuses.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("unavailable");
  expect(statuses.get(citationProbeKey({ versionPublicId: "a-v1" }))?.excerptDisplayable).toBe(false);
  expect(statuses.get(citationProbeKey({ versionPublicId: "b-v1", captureEntitlementRevision: "7" }))?.fulltextOpenable).toBe(false);

  let seenCaptureBasis: unknown;
  const okFetch = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { citations: { captureEntitlementRevision?: string }[] };
    seenCaptureBasis = body.citations[1]?.captureEntitlementRevision;
    return Promise.resolve(new Response(JSON.stringify({ statuses: [verifiable, locked] }), { status: 200 }));
  };
  const okStatuses = await loadCitationStatuses(
    [{ versionPublicId: "a-v1" }, { versionPublicId: "b-v1", captureEntitlementRevision: "7" }],
    { fetchImpl: okFetch, getToken: () => "token" },
  );
  expect(seenCaptureBasis).toBe("7");
  expect(okStatuses.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("verifiable");
  expect(okStatuses.get(citationProbeKey({ versionPublicId: "b-v1", captureEntitlementRevision: "7" }))?.state).toBe("locked");
});

test("状态加载：超过 50 条分批", async () => {
  const probes = Array.from({ length: 60 }, (_, index) => ({ versionPublicId: `v-${index}` }));
  const batches: number[] = [];
  const fetchImpl = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { citations: { index: number }[] };
    batches.push(body.citations.length);
    return Promise.resolve(new Response(JSON.stringify({ statuses: [] }), { status: 200 }));
  };
  await loadCitationStatuses(probes, { fetchImpl, getToken: () => null });
  expect(batches).toEqual([50, 10]);
});

test("会话生命周期：切换工作区同版本重新核验，迟到结果按代丢弃", async () => {
  let resolveA: ((map: Map<string, CitationStatusEntry>) => void) | undefined;
  const store = createCitationStatusStore({
    load: (probes) => {
      if (probes[0]?.versionPublicId === "a-v1" && !resolveA) {
        return new Promise((resolve) => {
          resolveA = (map) => resolve(map);
        });
      }
      // 工作区 B / 重查：同一版本当前为锁定（fail closed 语义由服务端决定）。
      return Promise.resolve(new Map([
        [citationProbeKey({ versionPublicId: "a-v1" }), { ...locked, versionPublicId: "a-v1" }],
      ]));
    },
  });
  const probes = citableCitations([citation(1, "a-v1")]);

  store.beginSession("ws-a");
  const pendingA = store.ensure(probes);
  store.beginSession("ws-b"); // 切换上下文：A 的在途请求作废
  const settled = await store.ensure(probes);
  expect(settled?.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("locked");

  resolveA!(new Map([[citationProbeKey({ versionPublicId: "a-v1" }), verifiable]]));
  expect(await pendingA).toBeNull(); // 迟到的 A 上下文结果被丢弃
});

test("会话生命周期：关闭后重开重新核验（到期/撤回反映为当前状态），失败可恢复", async () => {
  let down = true;
  const store = createCitationStatusStore({
    load: async () => {
      if (down) throw new Error("down");
      return new Map([[citationProbeKey({ versionPublicId: "a-v1" }), { ...tombstoned, versionPublicId: "a-v1" }]]);
    },
  });
  const probes = citableCitations([citation(1, "a-v1")]);

  store.beginSession("ws-a");
  const failed = await store.ensure(probes);
  expect(failed?.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("unavailable");

  // 失败不永久记账：下一轮 ensure 重试（成功后回填真实状态）。
  down = false;
  const retried = await store.ensure(probes);
  expect(retried?.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("tombstoned");

  // 关闭抽屉（期间订阅到期/来源撤回）→ 重新打开必须重新核验，不沿用旧会话结果。
  store.endSession();
  store.beginSession("ws-a");
  const reopened = await store.ensure(probes);
  expect(reopened?.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("tombstoned");
});

test("会话生命周期：导出前 refresh 强制重查，不沿用缓存做展示判定", async () => {
  let current: CitationStatusEntry = verifiable;
  let calls = 0;
  const store = createCitationStatusStore({
    load: async () => {
      calls += 1;
      return new Map([[citationProbeKey({ versionPublicId: "a-v1" }), current]]);
    },
  });
  const probes = citableCitations([citation(1, "a-v1", "7")]);
  store.beginSession("ws-a");
  await store.ensure(probes);
  expect(calls).toBe(1);

  current = { ...tombstoned, versionPublicId: "a-v1" }; // 导出前来源被撤回
  const fresh = await store.refresh(probes);
  expect(calls).toBe(2);
  expect(fresh?.get(citationProbeKey({ versionPublicId: "a-v1" }))?.state).toBe("tombstoned");
});

test("报告级四态汇总：可核验/锁定/墓碑/不可核验分列，可重跑只表状态", () => {
  const citations = [citation(1, "a-v1"), citation(2, "b-v1"), citation(3, "c-v1")];
  const statuses = new Map([
    [citationProbeKey({ versionPublicId: "a-v1" }), verifiable],
    [citationProbeKey({ versionPublicId: "b-v1" }), locked],
    [citationProbeKey({ versionPublicId: "c-v1" }), tombstoned],
  ]);
  expect(summarizeCitationStates(citations, statuses)).toEqual({
    verifiable: 1, locked: 1, tombstoned: 1, unavailable: 0, workspace: 0, incompletePointer: 0, rerunnable: true,
  });
  expect(summarizeCitationStates([], statuses).rerunnable).toBe(false);
});

test("汇总口径：工作区资料与指针不完整不并入暂不可核验（与导出一致）", () => {
  const citations: ResourceCitationDTO[] = [
    citation(1, "a-v1"), // 平台可核验
    { index: 2, title: "工作区资料", resourceId: "resource_item:x", platformContent: null }, // 工作区引用
    { index: 3, title: "外部来源", resourceId: "resource_item:x", platformContent: null, sourceUrl: "https://example.test" }, // 外部链接
    {
      index: 4, title: "指针缺失", resourceId: "content_item:x", platformContent: {
        itemId: "content_item:x", versionId: "content_version:x", sourceKey: "s", locator: null,
      },
    } as unknown as ResourceCitationDTO, // 平台引用但缺 versionPublicId
    citation(5, "c-v1"), // 平台墓碑
  ];
  const statuses = new Map([
    [citationProbeKey({ versionPublicId: "a-v1" }), verifiable],
    [citationProbeKey({ versionPublicId: "c-v1" }), tombstoned],
  ]);
  expect(summarizeCitationStates(citations, statuses)).toEqual({
    verifiable: 1, locked: 0, tombstoned: 1, unavailable: 0, workspace: 2, incompletePointer: 1, rerunnable: true,
  });
});

test("重跑问题取自该回答前最近的用户消息，缺失返回 null", () => {
  const messages = [
    { id: "m1", role: "user", content: " 生成当前债权审核摘要 " },
    { id: "m2", role: "assistant", content: "回答 [1]" },
    { id: "m3", role: "assistant", content: "回答2 [1]" },
  ];
  expect(rerunQuestionFor(messages, "m2")).toBe("生成当前债权审核摘要");
  expect(rerunQuestionFor(messages, "m3")).toBe("生成当前债权审核摘要");
  expect(rerunQuestionFor([{ id: "m9", role: "assistant", content: "x" }], "m9")).toBeNull();
});
