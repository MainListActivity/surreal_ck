/**
 * LCA09 历史引用按当前权限展示：对研究报告里保存的平台引用逐项核验当前权限。
 *
 * 复用 03/04 的授权计划器（planContentReaderExchange）做判定——与打开正文完全
 * 同一条授权规则，只是不换票、不写投影、不返回任何内容：
 * - 可核验（verifiable）：当前授权覆盖该精确版本，全文可打开（打开时仍走当时换票）；
 * - 锁定（locked）：降级/到期等当前权益不含该版本——成果与已捕获摘录保留，全文关闭；
 * - 墓碑（tombstoned）：来源撤回、许可终止、下架或删除要求——优先于历史套餐，
 *   展示 tombstone 与原因类别，不展示摘录，不暴露被要求删除的实质内容；
 * - 不可用（unavailable）：成员/工作区状态或平台服务问题——权限未知时不扩大展示。
 *
 * 事实读取走 content_projection_sync 受限会话（与 search-exchange 相同的控制面
 * 读取路径，仅 metadata 事实，不读正文）；调用者永远拿不到投影或 IdP 细节。
 */
import type { CitationStatusReason, SessionUser } from "@surreal-ck/shared";
import type { CitationStatusEntry } from "@surreal-ck/shared";
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

/** 纯分类：同一授权计划器判定，映射到展示状态与原因类别。 */
export function classifyCitationStatus(input: {
  caller: CallerFacts;
  entitlement: ContentReaderEntitlement | null;
  target: ContentReaderTarget | null;
  versionPublicId: string;
  nowSeconds: number;
}): CitationClassification {
  // 版本/条目在内容库已不存在：删除要求或记录回收——墓碑，隐藏摘录。
  if (!input.target) {
    return { state: "tombstoned", reason: "deleted", fulltextOpenable: false, excerptDisplayable: false };
  }
  const planned = planContentReaderExchange({
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
    entitlement: input.entitlement,
    content: input.target,
  });
  if (planned.ok) {
    return { state: "verifiable", reason: null, fulltextOpenable: true, excerptDisplayable: true };
  }
  return classifyFromError(planned.error);
}

function classifyFromError(error: string): CitationClassification {
  switch (error) {
    case "content_withdrawn":
      return { state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false };
    case "content_not_published":
      return { state: "tombstoned", reason: "unpublished", fulltextOpenable: false, excerptDisplayable: false };
    case "license_unknown":
    case "license_expired":
      return { state: "tombstoned", reason: "license_unavailable", fulltextOpenable: false, excerptDisplayable: false };
    case "collection_denied":
      return { state: "locked", reason: "collection_not_covered", fulltextOpenable: false, excerptDisplayable: true };
    case "action_denied":
      return { state: "locked", reason: "action_not_covered", fulltextOpenable: false, excerptDisplayable: true };
    case "entitlement_absent":
      return { state: "locked", reason: "entitlement_absent", fulltextOpenable: false, excerptDisplayable: true };
    case "entitlement_expired":
      return { state: "locked", reason: "entitlement_expired", fulltextOpenable: false, excerptDisplayable: true };
    case "workspace_inactive":
      return { state: "unavailable", reason: "workspace_inactive", fulltextOpenable: false, excerptDisplayable: false };
    case "member_removed":
    case "not_member":
      return { state: "unavailable", reason: "member_removed", fulltextOpenable: false, excerptDisplayable: false };
    // invalid_lifetime / idp_rejected / client_authority_rejected / 未知错误码：
    // 权限未知时不扩大访问，也不展示摘录。
    default:
      return { state: "unavailable", reason: "platform_unavailable", fulltextOpenable: false, excerptDisplayable: false };
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
  request: { citations: ReadonlyArray<{ index: number; versionPublicId: string }> },
): Promise<{ statuses: CitationStatusEntry[] }> {
  const facts = await loadCallerFacts();
  const entitlement = await loadEntitlement(facts.workspaceId);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const distinctIds = [...new Set(request.citations.map((citation) => citation.versionPublicId))];
  const classified = new Map<string, CitationClassification>();
  for (const versionPublicId of distinctIds) {
    const target = await fetchTarget(versionPublicId);
    classified.set(versionPublicId, classifyCitationStatus({
      caller: facts,
      entitlement,
      target,
      versionPublicId,
      nowSeconds,
    }));
  }

  // 响应只含状态与原因类别：不含正文、摘录内容、投影或 IdP 细节。
  const statuses = request.citations.map((citation) => {
    const entry = classified.get(citation.versionPublicId)!;
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
