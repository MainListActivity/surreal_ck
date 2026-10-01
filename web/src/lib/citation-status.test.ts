import { test, expect } from "bun:test";
import type { CitationStatusEntry, ResourceCitationDTO } from "@surreal-ck/shared";
import {
  citableVersionPublicIds,
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

const citation = (index: number, versionPublicId: string): ResourceCitationDTO => ({
  index, title: `t${index}`, resourceId: "content_item:x",
  platformContent: { itemId: "content_item:x", versionId: "content_version:x", versionPublicId, sourceKey: "s", locator: null },
});

test("指针抽取：去重并跳过缺失 versionPublicId 的历史指针", () => {
  const citations = [citation(1, "a-v1"), citation(2, "a-v1"), citation(3, "b-v1"), {
    index: 4, title: "t4", resourceId: "resource_item:x", platformContent: {
      itemId: "content_item:x", versionId: "content_version:x", sourceKey: "s", locator: null,
    },
  } as unknown as ResourceCitationDTO];
  expect(citableVersionPublicIds(citations)).toEqual(["a-v1", "b-v1"]);
});

test("状态加载：按版本回填；请求失败 fail closed 全部不可用", async () => {
  const calls: string[][] = [];
  const fetchImpl = (input: string | URL): Promise<Response> => {
    calls.push(String(input));
    return Promise.reject(new Error("down"));
  };
  const statuses = await loadCitationStatuses(["a-v1", "b-v1"], { fetchImpl, getToken: () => null });
  expect(statuses.get("a-v1")?.state).toBe("unavailable");
  expect(statuses.get("a-v1")?.excerptDisplayable).toBe(false);
  expect(statuses.get("b-v1")?.fulltextOpenable).toBe(false);

  const okFetch = (input: string | URL): Promise<Response> => {
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({
      statuses: [verifiable, locked],
    }), { status: 200 }));
  };
  const okStatuses = await loadCitationStatuses(["a-v1", "b-v1"], { fetchImpl: okFetch, getToken: () => "token" });
  expect(okStatuses.get("a-v1")?.state).toBe("verifiable");
  expect(okStatuses.get("b-v1")?.state).toBe("locked");
});

test("状态加载：超过 50 条分批", async () => {
  const ids = Array.from({ length: 60 }, (_, index) => `v-${index}`);
  const batches: number[] = [];
  const fetchImpl = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { citations: { index: number }[] };
    batches.push(body.citations.length);
    return Promise.resolve(new Response(JSON.stringify({ statuses: [] }), { status: 200 }));
  };
  await loadCitationStatuses(ids, { fetchImpl, getToken: () => null });
  expect(batches).toEqual([50, 10]);
});

test("报告级四态汇总：可核验/锁定/墓碑/不可核验分列，可重跑只表状态", () => {
  const citations = [citation(1, "a-v1"), citation(2, "b-v1"), citation(3, "c-v1")];
  const statuses = new Map([["a-v1", verifiable], ["b-v1", locked], ["c-v1", tombstoned]]);
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
  const statuses = new Map([["a-v1", verifiable], ["c-v1", tombstoned]]);
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
