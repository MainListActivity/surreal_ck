import { describe, expect, test } from "bun:test";
import type { SessionUser } from "@surreal-ck/shared";
import { classifyCitationStatus, createCitationStatusHandler, type CallerFacts } from "./citation-status";
import type { ContentReaderEntitlement, ContentReaderTarget } from "../content/reader-exchange";

const NOW = 1_700_000_000;
const LATER = NOW + 3_600;

const activeCaller: CallerFacts = {
  workspaceId: "ws_demo",
  workspaceActive: true,
  membership: "active",
  subjectInActiveIndex: true,
  subjectExpiresAtSeconds: LATER,
};

const fullEntitlement: ContentReaderEntitlement = {
  revision: 7,
  digest: "sha256:digest",
  resolverVersion: "v1",
  effectiveUntilSeconds: null,
  collections: ["core", "plus"],
  contentActions: ["browse", "search", "read", "cite", "export"],
  aiActions: ["research", "generate"],
};

function target(overrides: Partial<ContentReaderTarget> = {}): ContentReaderTarget {
  return {
    versionId: "content_version:1",
    itemId: "content_item:1",
    licenseId: "source_license_revision:1",
    sourceActive: true,
    publicationStatus: "published",
    collectionKeys: ["core"],
    licenseFromSeconds: NOW - 1_000,
    licenseUntilSeconds: null,
    licenseActions: ["browse", "search", "read", "cite", "export", "research", "generate"],
    ...overrides,
  };
}

describe("classifyCitationStatus（LCA09 引用按当前权限展示）", () => {
  test("当前授权覆盖 → 可核验，全文可打开，摘录可展示", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: true });
  });

  test("版本/条目已删除 → 墓碑（deleted），摘录隐藏", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: null, versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "tombstoned", reason: "deleted", fulltextOpenable: false, excerptDisplayable: false });
  });

  test("来源撤回/下架 → 墓碑（unpublished），摘录隐藏", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: target({ publicationStatus: "withdrawn" }), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false });
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: target({ sourceActive: false }), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false });
  });

  test("来源许可终止/未知 → 墓碑（license_unavailable），优先于历史套餐", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: target({ licenseActions: [] }), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "tombstoned", reason: "license_unavailable", fulltextOpenable: false, excerptDisplayable: false });
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: fullEntitlement, target: target({ licenseUntilSeconds: NOW - 1 }), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "tombstoned", reason: "license_unavailable", fulltextOpenable: false, excerptDisplayable: false });
  });

  test("Pro 降 Plus：版本超出当前集合 → 锁定，成果与摘录保留、全文关闭", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: { ...fullEntitlement, collections: ["core"] }, target: target({ collectionKeys: ["pro"] }), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: true });
  });

  test("到期进入保留模式 → 锁定（entitlement_absent/expired），存量保留", () => {
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: null, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "locked", reason: "entitlement_absent", fulltextOpenable: false, excerptDisplayable: true });
    expect(classifyCitationStatus({
      caller: activeCaller, entitlement: { ...fullEntitlement, effectiveUntilSeconds: NOW - 1 }, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    })).toEqual({ state: "locked", reason: "entitlement_expired", fulltextOpenable: false, excerptDisplayable: true });
  });

  test("成员移除/工作区停用/身份过期 → 不可用，权限未知不扩大展示", () => {
    const removed = classifyCitationStatus({
      caller: { ...activeCaller, membership: "removed", subjectInActiveIndex: false }, entitlement: fullEntitlement, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    });
    expect(removed).toEqual({ state: "unavailable", reason: "member_removed", fulltextOpenable: false, excerptDisplayable: false });
    const inactive = classifyCitationStatus({
      caller: { ...activeCaller, workspaceActive: false }, entitlement: fullEntitlement, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    });
    expect(inactive.state).toBe("unavailable");
    const expiredSubject = classifyCitationStatus({
      caller: { ...activeCaller, subjectExpiresAtSeconds: NOW - 1 }, entitlement: fullEntitlement, target: target(), versionPublicId: "law-2026-1", nowSeconds: NOW,
    });
    expect(expiredSubject.state).toBe("unavailable");
    expect(expiredSubject.excerptDisplayable).toBe(false);
  });
});

describe("citation-status handler（注入事实依赖）", () => {
  const caller: SessionUser = { subject: "user:u1", email: "u1@test.dev", raw: { db: "ws_demo", exp: NOW + 100 }, rawToken: "token" };
  const request = {
    citations: [
      { index: 1, versionPublicId: "law-2026-1" },
      { index: 2, versionPublicId: "law-2026-2" },
      { index: 3, versionPublicId: "law-2026-1" },
    ],
  };

  test("按版本去重核验、按引用回填；响应不含内容字段", async () => {
    const fetched: string[] = [];
    const handler = createCitationStatusHandler({
      loadCallerFacts: async () => activeCaller,
      loadEntitlement: async () => fullEntitlement,
      fetchTarget: async (publicId) => {
        fetched.push(publicId);
        return target();
      },
    });
    const result = await handler(caller, request);
    // 同版本只核验一次。
    expect(fetched).toEqual(["law-2026-1", "law-2026-2"]);
    expect(result.statuses.map((status) => status.index)).toEqual([1, 2, 3]);
    expect(result.statuses[2]!.versionPublicId).toBe("law-2026-1");
    // 响应只含状态与原因类别，不含任何正文/摘录/投影字段。
    expect(result.statuses.every((status) => {
      const keys = Object.keys(status);
      return keys.every((key) => ["index", "versionPublicId", "state", "reason", "fulltextOpenable", "excerptDisplayable"].includes(key));
    })).toBe(true);
  });

  test("打开失败 fail closed：全部状态不可用，摘录不展示", async () => {
    const handler = createCitationStatusHandler({
      loadCallerFacts: async () => { throw new Error("projection down"); },
      loadEntitlement: async () => null,
      fetchTarget: async () => null,
    });
    await expect(handler(caller, request)).rejects.toBeInstanceOf(Error);
  });
});
