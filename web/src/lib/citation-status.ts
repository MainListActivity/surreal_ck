/**
 * LCA09 历史引用按当前权限展示：前端状态加载与展示口径。
 *
 * 报告可见性属于用户数据（workspace 永不因平台失权隐藏）；这里只处理平台引用的
 * 当前权限四态：可核验 / 全文锁定 / 墓碑（撤回·许可终止·删除）/ 暂不可核验。
 * 服务端只回状态与原因类别，不回内容；失败一律 fail closed（不可核验）。
 */
import type { CitationStatusEntry, ResourceCitationDTO } from "@surreal-ck/shared";
import { citationStatusRequestSchema } from "@surreal-ck/shared";
import { getToken } from "./auth";

export type CitationStatusOptions = {
  baseUrl?: string;
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
};

/** 抽取需要核验的平台引用指针（去重、过滤缺失 versionPublicId 的历史指针）。 */
export function citableVersionPublicIds(citations: ResourceCitationDTO[]): string[] {
  const ids = citations
    .map((citation) => citation.platformContent?.versionPublicId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

/**
 * 加载平台引用的当前权限状态，返回 versionPublicId → 状态。
 * 请求按 50 条分批；任一批失败时，该批版本全部回退为“暂不可核验”（fail closed），
 * 不阻塞报告展示。
 */
export async function loadCitationStatuses(
  versionPublicIds: string[],
  options: CitationStatusOptions = {},
): Promise<Map<string, CitationStatusEntry>> {
  const statuses = new Map<string, CitationStatusEntry>();
  if (versionPublicIds.length === 0) return statuses;
  const getTokenFn = options.getToken ?? getToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  for (let start = 0; start < versionPublicIds.length; start += 50) {
    const batch = versionPublicIds.slice(start, start + 50).map((versionPublicId, offset) => ({
      index: start + offset + 1,
      versionPublicId,
    }));
    const parsed = citationStatusRequestSchema.safeParse({ citations: batch });
    if (!parsed.success) {
      for (const item of batch) {
        statuses.set(item.versionPublicId, unavailableEntry(item.versionPublicId));
      }
      continue;
    }
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = getTokenFn();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(`${baseUrl}/api/legal/citation-status`, {
        method: "POST",
        headers,
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error(`citation status ${response.status}`);
      const body = (await response.json()) as { statuses?: CitationStatusEntry[] };
      for (const entry of body.statuses ?? []) {
        statuses.set(entry.versionPublicId, entry);
      }
    } catch {
      for (const item of batch) {
        statuses.set(item.versionPublicId, unavailableEntry(item.versionPublicId));
      }
    }
  }
  return statuses;
}

function unavailableEntry(versionPublicId: string): CitationStatusEntry {
  return {
    index: 0,
    versionPublicId,
    state: "unavailable",
    reason: "platform_unavailable",
    fulltextOpenable: false,
    excerptDisplayable: false,
  };
}

/** 报告级汇总口径（与导出一致）：四态只统计平台引用；工作区资料与指针不完整单列。 */
export type CitationSummary = {
  /** 平台引用：当前授权可核验（全文可打开）。 */
  verifiable: number;
  /** 平台引用：全文锁定（降 Plus/保留模式），摘录保留。 */
  locked: number;
  /** 平台引用：撤回/许可终止/删除，摘录隐藏。 */
  tombstoned: number;
  /** 平台引用：核验失败或状态未知（fail closed，暂不可核验）。 */
  unavailable: number;
  /** 工作区资料引用（无 platformContent）：按原 workspace 权限继续可用，不走平台 gate。 */
  workspace: number;
  /** 平台引用但缺 versionPublicId：历史指针不完整，需重新研究。 */
  incompletePointer: number;
  /** 可重跑 ≠ 旧引用快照可复用：重跑是新成果版本，用当前授权与收费规则。 */
  rerunnable: boolean;
};

export function summarizeCitationStates(
  citations: ResourceCitationDTO[],
  statuses: Map<string, CitationStatusEntry>,
): CitationSummary {
  let verifiable = 0;
  let locked = 0;
  let tombstoned = 0;
  let unavailable = 0;
  let workspace = 0;
  let incompletePointer = 0;
  for (const citation of citations) {
    const versionPublicId = citation.platformContent?.versionPublicId;
    if (!citation.platformContent) {
      // 工作区资料/外部来源引用：不属于平台内容 gate，导出按原 workspace 权限标注。
      workspace += 1;
      continue;
    }
    if (!versionPublicId) {
      // 历史指针不完整：与“平台不可核验”分开计数，避免夸大平台失权。
      incompletePointer += 1;
      continue;
    }
    const entry = statuses.get(versionPublicId);
    if (!entry) {
      unavailable += 1;
      continue;
    }
    if (entry.state === "verifiable") verifiable += 1;
    else if (entry.state === "locked") locked += 1;
    else if (entry.state === "tombstoned") tombstoned += 1;
    else unavailable += 1;
  }
  return { verifiable, locked, tombstoned, unavailable, workspace, incompletePointer, rerunnable: citations.length > 0 };
}

/** 历史消息的原始问题（重跑用）：取该助手消息前最近一条用户消息。 */
export function rerunQuestionFor(
  messages: ReadonlyArray<{ id: string; role: string; content: string }>,
  assistantMessageId: string,
): string | null {
  const index = messages.findIndex((message) => message.id === assistantMessageId && message.role === "assistant");
  if (index <= 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]!;
    if (message.role === "user" && message.content.trim()) return message.content.trim();
  }
  return null;
}
