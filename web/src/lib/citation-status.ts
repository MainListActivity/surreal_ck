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

/** 报告级四态汇总：报告可见（用户数据恒成立）+ 引用可核验/全文可打开/可重跑。 */
export function summarizeCitationStates(
  citations: ResourceCitationDTO[],
  statuses: Map<string, CitationStatusEntry>,
): { verifiable: number; locked: number; tombstoned: number; unavailable: number; rerunnable: boolean } {
  let verifiable = 0;
  let locked = 0;
  let tombstoned = 0;
  let unavailable = 0;
  for (const citation of citations) {
    const entry = citation.platformContent?.versionPublicId
      ? statuses.get(citation.platformContent.versionPublicId)
      : undefined;
    if (!entry) {
      unavailable += 1;
      continue;
    }
    if (entry.state === "verifiable") verifiable += 1;
    else if (entry.state === "locked") locked += 1;
    else if (entry.state === "tombstoned") tombstoned += 1;
    else unavailable += 1;
  }
  // 可重跑 ≠ 旧引用快照可复用：重跑是新成果版本，用当前授权与收费规则。
  const rerunnable = citations.length > 0;
  return { verifiable, locked, tombstoned, unavailable, rerunnable };
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
