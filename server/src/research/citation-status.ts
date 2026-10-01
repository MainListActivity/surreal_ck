/**
 * LCA09 历史引用按当前权限展示：对研究报告里保存的平台引用逐项核验当前权限。
 *
 * 授权事实与 03/04 完全同一套谓词（仍由 planContentReaderExchange 解释——同一
 * 授权规则，只是不换票、不写投影、不返回任何内容）；但展示分类按「留存优先级」
 * 排序，不照搬换票的错误返回顺序：
 * 1) 身份/工作区无效 → unavailable（fail closed，优先于一切展示）；
 * 2) 来源/许可侧死亡事实（撤回/下架/许可终止·未知/删除）→ tombstoned，摘录隐藏。
 *    用全动作探针权益调用计划器，让来源侧事实不被真实权益缺失/到期掩盖
 *    （AC5：撤回/许可终止/删除要求优先于历史套餐）；
 * 3) 真实权益不足（absent/expired/集合缩减/动作不含 read）→ locked，
 *    摘录仅在捕获依据（captureEntitlementRevision，捕获时经授权管道登记）存在时
 *    按保留模式保留；
 * 4) 真实权益含 read → verifiable：全文可打开（打开时仍走当时换票），
 *    摘录还需当前展示许可（license ∩ 权益含 cite）与捕获依据。
 * 未知/服务错误一律 fail closed（unavailable，摘录不展示）。
 *
 * 事实读取走 content_projection_sync 受限会话（与 search-exchange 相同的控制面
 * 读取路径，仅 metadata 事实，不读正文）；调用者永远拿不到投影或 IdP 细节。
 */
import {
  AI_TEMPLATE_ACTIONS,
  CONTENT_ACTIONS,
  PRODUCT_ENTITLEMENT_RESOLVER_VERSION,
  type CitationStatusReason,
  type CitationStatusEntry,
  type SessionUser,
} from "@surreal-ck/shared";
import type { ContentReaderEntitlement, ContentReaderTarget } from "../content/reader-exchange";
import { planContentReaderExchange } from "../content/reader-exchange";

export type CallerFacts = {
  workspaceId: string;
  workspaceActive: boolean;
  membership: "active" | "removed" | "absent";
  subjectInActiveIndex: boolean;
  subjectExpiresAtSeconds: number;
};

export type CitationClassification = Pick<CitationStatusEntry, "state" | "reason" | "fulltextOpenable" | "excerptDisplayable">;

/** 来源/许可侧死亡事实：无论当前权益如何都要求墓碑（takedown 优先）。 */
const TOMBSTONE_ERRORS: ReadonlySet<string> = new Set([
  "content_withdrawn",
  "content_not_published",
  "license_unknown",
  "license_expired",
]);

const CAPTURE_REVISION_PATTERN = /^[1-9][0-9]*$/u;

function unavailable(reason: CitationStatusReason): CitationClassification {
  return { state: "unavailable", reason, fulltextOpenable: false, excerptDisplayable: false };
}

function tombstoned(reason: CitationStatusReason): CitationClassification {
  return { state: "tombstoned", reason, fulltextOpenable: false, excerptDisplayable: false };
}

/** 捕获依据：引用登记了捕获时的授权修订（授权研究管道写入，quoteAllowed 语义）。 */
function hasCaptureBasis(revision: string | undefined): boolean {
  return typeof revision === "string" && CAPTURE_REVISION_PATTERN.test(revision);
}

/**
 * 全动作探针权益：让计划器越过权益检查、只表达来源/许可侧事实。
 * 集合取目标自身集合 → 不会 collection_denied；无到期 → 不会 entitlement_expired。
 */
function probeEntitlement(collections: readonly string[]): ContentReaderEntitlement {
  return {
    revision: 1,
    digest: "sha256:citation-status-probe",
    resolverVersion: PRODUCT_ENTITLEMENT_RESOLVER_VERSION,
    effectiveUntilSeconds: null,
    collections: [...collections],
    contentActions: CONTENT_ACTIONS,
    aiActions: AI_TEMPLATE_ACTIONS,
  };
}

function plannerInput(input: {
  caller: CallerFacts;
  target: ContentReaderTarget | null;
  versionPublicId: string;
  nowSeconds: number;
}, entitlement: ContentReaderEntitlement | null) {
  return {
    body: { contentPublicId: input.versionPublicId },
    subject: "citation-status",
    workspaceDb: "citation-status",
    workspaceActive: input.caller.workspaceActive,
    membership: input.caller.membership,
    activeSubjects: input.caller.subjectInActiveIndex ? ["citation-status"] : [],
    subjectExpiresAtSeconds: input.caller.subjectExpiresAtSeconds,
    nowSeconds: input.nowSeconds,
    subjectIsContentReader: false,
    database: "citation-status",
    namespace: "citation-status",
    entitlement,
    content: input.target,
  };
}

/** 身份/工作区事实与计划器同一谓词；无效身份不暴露任何内容状态。 */
function identityFailure(caller: CallerFacts, nowSeconds: number): CitationClassification | null {
  if (!caller.workspaceActive) return unavailable("workspace_inactive");
  if (caller.membership !== "active" || !caller.subjectInActiveIndex) return unavailable("member_removed");
  if (caller.subjectExpiresAtSeconds <= nowSeconds) return unavailable("platform_unavailable");
  return null;
}

/** 纯分类：同一授权计划器判定事实，按留存优先级映射到展示状态与原因类别。 */
export function classifyCitationStatus(input: {
  caller: CallerFacts;
  entitlement: ContentReaderEntitlement | null;
  target: ContentReaderTarget | null;
  versionPublicId: string;
  /** 引用捕获时登记的授权修订（捕获许可依据）；缺失视为无留存依据。 */
  captureEntitlementRevision?: string;
  nowSeconds: number;
}): CitationClassification {
  // 1) 身份/工作区无效：权限未知，fail closed。
  const identity = identityFailure(input.caller, input.nowSeconds);
  if (identity) return identity;

  // 2) 来源/许可侧死亡事实优先于历史套餐（探针只暴露来源事实）。
  if (!input.target) {
    return tombstoned("deleted");
  }
  const probe = planContentReaderExchange(plannerInput(input, probeEntitlement(input.target.collectionKeys)));
  if (!probe.ok && TOMBSTONE_ERRORS.has(probe.error)) {
    switch (probe.error) {
      case "content_withdrawn":
      case "content_not_published":
        return tombstoned("unpublished");
      case "license_unknown":
      case "license_expired":
        return tombstoned("license_unavailable");
    }
  }

  // 3)+4) 来源存活：按真实权益判定可核验/锁定与动作位。
  const captureBasis = hasCaptureBasis(input.captureEntitlementRevision);
  const planned = planContentReaderExchange(plannerInput(input, input.entitlement));
  if (planned.ok) {
    const entitlement = input.entitlement!;
    const licensed = new Set(input.target.licenseActions);
    const allowed = entitlement.contentActions.filter((action) => licensed.has(action));
    const read = allowed.includes("read");
    const cite = allowed.includes("cite");
    return {
      state: read ? "verifiable" : "locked",
      reason: read ? null : "action_not_covered",
      fulltextOpenable: read,
      // 摘录 = 捕获许可（依据已登记）∧ 当前展示许可（cite）。
      excerptDisplayable: cite && captureBasis,
    };
  }
  const captureOrHidden = captureBasis;
  switch (planned.error) {
    case "collection_denied":
      return { state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: captureOrHidden };
    case "entitlement_absent":
      return { state: "locked", reason: "entitlement_absent", fulltextOpenable: false, excerptDisplayable: captureOrHidden };
    case "entitlement_expired":
      return { state: "locked", reason: "entitlement_expired", fulltextOpenable: false, excerptDisplayable: captureOrHidden };
    case "action_denied":
      // 权益与许可无任何交集动作：当前展示许可必然不含 cite。
      return { state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: false };
    // workspace_inactive / not_member / member_removed 已在身份检查覆盖；
    // projection_incomplete / invalid_lifetime / idp_rejected 等未知或服务错误
    // → 权限未知，不扩大访问也不展示摘录。
    default:
      return unavailable("platform_unavailable");
  }
}

export type CitationStatusDeps = {
  /** 调用者事实（成员索引、工作区状态、身份有效性）。默认按 03/04 同一控制面读取。 */
  loadCallerFacts?(caller: SessionUser): Promise<CallerFacts>;
  /** 当前权益快照（digest/revision/collections/actions）。 */
  loadEntitlement?(workspaceId: string): Promise<ContentReaderEntitlement | null>;
  /** 内容库 metadata 事实快照（无正文）。 */
  fetchTarget?(versionPublicId: string): Promise<ContentReaderTarget | null>;
};

/** 生产默认实现：与 content search/reader 换票相同的控制面读取路径。 */
export function createCitationStatusHandler(deps: CitationStatusDeps = {}): (caller: SessionUser, request: {
  citations: ReadonlyArray<{ index: number; versionPublicId: string }>;
}) => Promise<{ statuses: CitationStatusEntry[] }> {
  const loadCallerFacts = deps.loadCallerFacts;
  const loadEntitlement = deps.loadEntitlement;
  const fetchTarget = deps.fetchTarget;
  return async (caller, request) => {
    if (loadCallerFacts && loadEntitlement && fetchTarget) {
      return runWithFacts(
        () => loadCallerFacts(caller),
        (workspaceId) => loadEntitlement(workspaceId),
        (versionPublicId) => fetchTarget(versionPublicId),
        caller,
        request,
      );
    }
    // 动态 import 避免测试装配时拉起真实连接。
    const { defaultProductionFacts } = await import("./citation-status-facts");
    return runWithFacts(
      () => defaultProductionFacts.loadCallerFacts(caller),
      (workspaceId) => defaultProductionFacts.loadEntitlement(workspaceId),
      (versionPublicId) => defaultProductionFacts.fetchTarget(versionPublicId),
      caller,
      request,
    );
  };
}

async function runWithFacts(
  loadCallerFacts: () => Promise<CallerFacts>,
  loadEntitlement: (workspaceId: string) => Promise<ContentReaderEntitlement | null>,
  fetchTarget: (versionPublicId: string) => Promise<ContentReaderTarget | null>,
  caller: SessionUser,
  request: { citations: ReadonlyArray<{ index: number; versionPublicId: string; captureEntitlementRevision?: string }> },
): Promise<{ statuses: CitationStatusEntry[] }> {
  const facts = await loadCallerFacts();
  const entitlement = await loadEntitlement(facts.workspaceId);
  const nowSeconds = Math.floor(Date.now() / 1000);

  // 同版本不同捕获依据（不同时期研究）的摘录展示判定可能不同：按 (版本, 依据) 去重。
  const distinct = new Map<string, { versionPublicId: string; captureEntitlementRevision?: string }>();
  for (const citation of request.citations) {
    const key = `${citation.versionPublicId}|${citation.captureEntitlementRevision ?? ""}`;
    if (!distinct.has(key)) {
      distinct.set(key, {
        versionPublicId: citation.versionPublicId,
        ...(citation.captureEntitlementRevision ? { captureEntitlementRevision: citation.captureEntitlementRevision } : {}),
      });
    }
  }
  const classified = new Map<string, CitationClassification>();
  for (const probe of distinct.values()) {
    const target = await fetchTarget(probe.versionPublicId);
    classified.set(`${probe.versionPublicId}|${probe.captureEntitlementRevision ?? ""}`, classifyCitationStatus({
      caller: facts,
      entitlement,
      target,
      versionPublicId: probe.versionPublicId,
      captureEntitlementRevision: probe.captureEntitlementRevision,
      nowSeconds,
    }));
  }

  // 响应只含状态与原因类别：不含正文、摘录内容、投影或 IdP 细节。
  const statuses = request.citations.map((citation) => {
    const entry = classified.get(`${citation.versionPublicId}|${citation.captureEntitlementRevision ?? ""}`)!;
    return {
      index: citation.index,
      versionPublicId: citation.versionPublicId,
      state: entry.state,
      reason: entry.reason,
      fulltextOpenable: entry.fulltextOpenable,
      excerptDisplayable: entry.excerptDisplayable,
    } satisfies CitationStatusEntry;
  });
  return { statuses };
}

export type { CitationStatusReason };
