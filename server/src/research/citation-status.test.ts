import { describe, expect, test } from "bun:test";
import type { SessionUser } from "@surreal-ck/shared";
import { classifyCitationStatus, createCitationStatusHandler, type CallerFacts } from "./citation-status";
import type { ContentReaderEntitlement, ContentReaderTarget } from "../content/reader-exchange";

// handler 用真实 Date.now()；夹具相对当前时间构造，避免身份被误判过期（fail closed 是期望行为时再显式构造）。
const NOW = Math.floor(Date.now() / 1000);
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

const BASIS = "7";

function classify(overrides: {
  entitlement?: ContentReaderEntitlement | null;
  target?: ContentReaderTarget | null;
  captureEntitlementRevision?: string;
  caller?: CallerFacts;
}) {
  return classifyCitationStatus({
    caller: overrides.caller ?? activeCaller,
    entitlement: overrides.entitlement === undefined ? fullEntitlement : overrides.entitlement,
    target: overrides.target === undefined ? target() : overrides.target,
    versionPublicId: "law-2026-1",
    captureEntitlementRevision: overrides.captureEntitlementRevision,
    nowSeconds: NOW,
  });
}

describe("classifyCitationStatus：来源/许可死亡事实优先于历史套餐（AC5）", () => {
  test("无权益 + 来源撤回 → 墓碑（unpublished），摘录隐藏（不被 entitlement_absent 掩盖）", () => {
    expect(classify({ entitlement: null, target: target({ publicationStatus: "withdrawn" }) })).toEqual({
      state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("权益与许可同时过期 → 墓碑（license_unavailable），摘录隐藏", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, effectiveUntilSeconds: NOW - 1 },
      target: target({ licenseUntilSeconds: NOW - 1 }),
    })).toEqual({
      state: "tombstoned", reason: "license_unavailable", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("集合缩减（Pro 降 Plus）+ 来源撤回 → 墓碑优先", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, collections: ["plus"] },
      target: target({ collectionKeys: ["core"], publicationStatus: "withdrawn" }),
    })).toEqual({
      state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("版本已删除 / 来源下架 / 许可未知 → 墓碑，摘录隐藏", () => {
    expect(classify({ target: null })).toEqual({
      state: "tombstoned", reason: "deleted", fulltextOpenable: false, excerptDisplayable: false,
    });
    expect(classify({ target: target({ sourceActive: false }) })).toEqual({
      state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false,
    });
    expect(classify({ target: target({ publicationStatus: "draft" }) })).toEqual({
      state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false,
    });
    expect(classify({ target: target({ licenseActions: [] }) })).toEqual({
      state: "tombstoned", reason: "license_unavailable", fulltextOpenable: false, excerptDisplayable: false,
    });
  });
});

describe("classifyCitationStatus：动作分离（read→全文，cite→摘录，捕获依据必需）", () => {
  test("read+cite + 捕获依据 → 可核验，全文可打开，摘录可展示", () => {
    expect(classify({ captureEntitlementRevision: BASIS })).toEqual({
      state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: true,
    });
  });

  test("可核验但无捕获依据 → 摘录不展示（不假设历史 evidence 可展示）", () => {
    expect(classify({})).toEqual({
      state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: false,
    });
  });

  test("browse-only（metadata 成功 ≠ read）→ 锁定（action_not_covered），全文与摘录都不开", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, contentActions: ["browse", "search"] },
      target: target({ licenseActions: ["browse", "search"] }),
    })).toEqual({
      state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("cite-only → 锁定，全文关闭；有捕获依据时摘录保留", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, contentActions: ["cite"] },
      target: target({ licenseActions: ["cite"] }),
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: true,
    });
  });

  test("read 无 cite → 可核验、全文可打开，摘录因当前展示许可不含 cite 隐藏", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, contentActions: ["browse", "read"] },
      target: target({ licenseActions: ["browse", "read"] }),
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: false,
    });
  });

  test("export-only → 锁定，摘录不展示", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, contentActions: ["export"] },
      target: target({ licenseActions: ["export"] }),
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("权益与许可无任何交集动作 → 锁定（action_not_covered），摘录不展示", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, contentActions: ["read"] },
      target: target({ licenseActions: ["publish"] }),
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: false,
    });
  });
});

describe("classifyCitationStatus：锁定态保留语义与 fail closed", () => {
  test("降 Plus（集合缩减）→ 锁定；有捕获依据时摘录保留，无依据不展示", () => {
    expect(classify({
      entitlement: { ...fullEntitlement, collections: ["core"] },
      target: target({ collectionKeys: ["pro"] }),
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: true,
    });
    expect(classify({
      entitlement: { ...fullEntitlement, collections: ["core"] },
      target: target({ collectionKeys: ["pro"] }),
    })).toEqual({
      state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: false,
    });
  });

  test("到期进入保留模式（absent/expired）→ 锁定，摘录按捕获依据保留", () => {
    expect(classify({ entitlement: null, captureEntitlementRevision: BASIS })).toEqual({
      state: "locked", reason: "entitlement_absent", fulltextOpenable: false, excerptDisplayable: true,
    });
    expect(classify({
      entitlement: { ...fullEntitlement, effectiveUntilSeconds: NOW - 1 },
      captureEntitlementRevision: BASIS,
    })).toEqual({
      state: "locked", reason: "entitlement_expired", fulltextOpenable: false, excerptDisplayable: true,
    });
  });

  test("成员移除/工作区停用/身份过期 → 不可用（fail closed，不暴露内容状态）", () => {
    const removed = classify({ caller: { ...activeCaller, membership: "removed", subjectInActiveIndex: false } });
    expect(removed).toEqual({ state: "unavailable", reason: "member_removed", fulltextOpenable: false, excerptDisplayable: false });
    // 成员移除时即使来源已撤回也不暴露墓碑事实。
    expect(classify({
      caller: { ...activeCaller, membership: "removed", subjectInActiveIndex: false },
      target: target({ publicationStatus: "withdrawn" }),
    }).state).toBe("unavailable");
    expect(classify({ caller: { ...activeCaller, workspaceActive: false } }).state).toBe("unavailable");
    const expiredSubject = classify({ caller: { ...activeCaller, subjectExpiresAtSeconds: NOW - 1 } });
    expect(expiredSubject.state).toBe("unavailable");
    expect(expiredSubject.excerptDisplayable).toBe(false);
  });
});

describe("citation-status handler（注入事实依赖）", () => {
  const caller: SessionUser = { subject: "user:u1", email: "u1@test.dev", raw: { db: "ws_demo", exp: NOW + 100 }, rawToken: "token" };
  const request = {
    citations: [
      { index: 1, versionPublicId: "law-2026-1", captureEntitlementRevision: BASIS },
      { index: 2, versionPublicId: "law-2026-2" },
      { index: 3, versionPublicId: "law-2026-1", captureEntitlementRevision: BASIS },
    ],
  };

  test("按 (版本, 捕获依据) 去重核验、按引用回填；响应不含内容字段", async () => {
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
    // 同 (版本, 依据) 只核验一次。
    expect(fetched).toEqual(["law-2026-1", "law-2026-2"]);
    expect(result.statuses.map((status) => status.index)).toEqual([1, 2, 3]);
    expect(result.statuses[2]!.versionPublicId).toBe("law-2026-1");
    // 响应只含状态与原因类别，不含任何正文/摘录/投影字段。
    expect(result.statuses.every((status) => {
      const keys = Object.keys(status);
      return keys.every((key) => ["index", "versionPublicId", "state", "reason", "fulltextOpenable", "excerptDisplayable"].includes(key));
    })).toBe(true);
    // 捕获依据参与判定：有依据的引用摘录可展示，无依据的不可展示。
    expect(result.statuses[0]!.excerptDisplayable).toBe(true);
    expect(result.statuses[1]!.excerptDisplayable).toBe(false);
  });

  test("打开失败 fail closed：拒绝请求，不返回任何状态", async () => {
    const handler = createCitationStatusHandler({
      loadCallerFacts: async () => { throw new Error("projection down"); },
      loadEntitlement: async () => null,
      fetchTarget: async () => null,
    });
    await expect(handler(caller, request)).rejects.toBeInstanceOf(Error);
  });
});
