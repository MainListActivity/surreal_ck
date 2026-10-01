/**
 * LCA09 历史引用按当前权限展示：前端状态加载与展示口径。
 *
 * 报告可见性属于用户数据（workspace 永不因平台失权隐藏）；这里只处理平台引用的
 * 当前权限四态：可核验 / 全文锁定 / 墓碑（撤回·许可终止·删除）/ 暂不可核验。
 * 服务端只回状态与原因类别，不回内容；失败一律 fail closed（不可核验）。
 *
 * 状态必须始终反映"当前"权限：缓存按会话（抽屉打开周期）与工作区隔离，
 * 关闭/切换/导出时重新核验，迟到结果按代丢弃；绝不把旧权限结果当当前权限用。
 */
import type { CitationStatusEntry, ResourceCitationDTO } from "@surreal-ck/shared";
import { citationStatusRequestSchema } from "@surreal-ck/shared";
import { getToken } from "./auth";

export type CitationStatusOptions = {
  baseUrl?: string;
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
};

/** 一次核验探针：精确版本指针 + 捕获依据（捕获时登记的授权修订）。 */
export type CitationStatusProbe = {
  versionPublicId: string;
  captureEntitlementRevision?: string;
};

/** 探针键：同版本不同捕获依据（不同时期研究）的摘录展示判定可能不同。 */
export function citationProbeKey(probe: CitationStatusProbe): string {
  return `${probe.versionPublicId}|${probe.captureEntitlementRevision ?? ""}`;
}

function probeFor(citation: ResourceCitationDTO): CitationStatusProbe | null {
  const versionPublicId = citation.platformContent?.versionPublicId;
  if (!versionPublicId) return null;
  const captureEntitlementRevision = citation.platformContent?.entitlementRevision;
  return captureEntitlementRevision ? { versionPublicId, captureEntitlementRevision } : { versionPublicId };
}

/** 抽取需要核验的平台引用探针（按探针键去重；缺失 versionPublicId 的历史指针跳过）。 */
export function citableCitations(citations: ResourceCitationDTO[]): CitationStatusProbe[] {
  const probes = new Map<string, CitationStatusProbe>();
  for (const citation of citations) {
    const probe = probeFor(citation);
    if (!probe) continue;
    const key = citationProbeKey(probe);
    if (!probes.has(key)) probes.set(key, probe);
  }
  return [...probes.values()];
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

/**
 * 加载平台引用的当前权限状态，返回探针键 → 状态。
 * 请求按 50 条分批；任一批失败时，该批探针全部回退为“暂不可核验”（fail closed），
 * 不阻塞报告展示。
 */
export async function loadCitationStatuses(
  probes: CitationStatusProbe[],
  options: CitationStatusOptions = {},
): Promise<Map<string, CitationStatusEntry>> {
  const statuses = new Map<string, CitationStatusEntry>();
  if (probes.length === 0) return statuses;
  const getTokenFn = options.getToken ?? getToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  const failClosed = (batch: CitationStatusProbe[]) => {
    for (const probe of batch) statuses.set(citationProbeKey(probe), unavailableEntry(probe.versionPublicId));
  };

  for (let start = 0; start < probes.length; start += 50) {
    const batch = probes.slice(start, start + 50).map((probe, offset) => ({
      index: start + offset + 1,
      ...probe,
    }));
    const parsed = citationStatusRequestSchema.safeParse({ citations: batch });
    if (!parsed.success) {
      failClosed(batch);
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
      const byIndex = new Map((body.statuses ?? []).map((entry) => [entry.index, entry]));
      for (const item of batch) {
        statuses.set(citationProbeKey(item), byIndex.get(item.index) ?? unavailableEntry(item.versionPublicId));
      }
    } catch {
      failClosed(batch);
    }
  }
  return statuses;
}

/**
 * 引用状态会话：缓存只在"当前会话 × 当前上下文"内有效。
 * - beginSession：抽屉打开；同上下文幂等，上下文（工作区/身份代）变化或新会话即失效缓存；
 * - endSession：抽屉关闭；下次打开必然重新核验（关闭期间的降级/撤回/重新订阅都能反映）；
 * - ensure：补齐未核验探针；失败 fail closed 且不永久记账（下轮重试）；迟到/跨代结果丢弃；
 * - refresh：导出等需要"当前核验"的动作——强制重查，不用缓存值做展示决定。
 */
export type CitationStatusStore = {
  beginSession(contextKey: string): void;
  endSession(): void;
  ensure(probes: CitationStatusProbe[]): Promise<Map<string, CitationStatusEntry> | null>;
  refresh(probes: CitationStatusProbe[]): Promise<Map<string, CitationStatusEntry> | null>;
};

export type CitationStatusStoreOptions = {
  load?: (probes: CitationStatusProbe[]) => Promise<Map<string, CitationStatusEntry>>;
};

export function createCitationStatusStore(options: CitationStatusStoreOptions = {}): CitationStatusStore {
  const load = options.load ?? loadCitationStatuses;
  let generation = 0;
  let contextKey: string | null = null;
  let sessionActive = false;
  const statuses = new Map<string, CitationStatusEntry>();
  const requested = new Set<string>();

  function invalidate(): void {
    generation += 1;
    statuses.clear();
    requested.clear();
  }

  async function ensure(probes: CitationStatusProbe[]): Promise<Map<string, CitationStatusEntry> | null> {
    if (probes.length === 0) return new Map(statuses);
    const pending = probes.filter((probe) => {
      const key = citationProbeKey(probe);
      return !requested.has(key) && !statuses.has(key);
    });
    if (pending.length === 0) return new Map(statuses);
    const requestGeneration = generation;
    for (const probe of pending) requested.add(citationProbeKey(probe));
    try {
      const loaded = await load(pending);
      // 迟到或跨上下文结果：已失效，丢弃，不让旧权限进入当前视图。
      if (requestGeneration !== generation) return null;
      for (const [key, entry] of loaded) statuses.set(key, entry);
      return new Map(statuses);
    } catch {
      if (requestGeneration !== generation) return null;
      // 失败 fail closed（暂不可核验），但不永久记账：下一轮 effect 重试。
      for (const probe of pending) requested.delete(citationProbeKey(probe));
      const failed = new Map(statuses);
      for (const probe of pending) failed.set(citationProbeKey(probe), unavailableEntry(probe.versionPublicId));
      return failed;
    }
  }

  return {
    beginSession(nextContextKey) {
      if (!sessionActive || nextContextKey !== contextKey) {
        invalidate();
        contextKey = nextContextKey;
      }
      sessionActive = true;
    },
    endSession() {
      sessionActive = false;
    },
    ensure,
    async refresh(probes) {
      invalidate();
      return ensure(probes);
    },
  };
}

/** 报告级汇总口径（与导出一致）：四态只统计平台引用；工作区资料与指针不完整单列。 */
export type CitationSummary = {
  /** 平台引用：当前授权可核验（全文可打开）。 */
  verifiable: number;
  /** 平台引用：全文锁定（降 Plus/保留模式），摘录按捕获依据保留。 */
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
    const entry = statuses.get(citationProbeKey({ versionPublicId, captureEntitlementRevision: citation.platformContent.entitlementRevision }));
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
