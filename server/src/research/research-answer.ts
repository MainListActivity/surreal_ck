/**
 * LCA06 可核验回答的纯逻辑：证据登记、提示词构建与后处理校验。
 *
 * 该模块无副作用、不触库，替身模型测试可以直接检查输入/输出：
 * - 模型只能看到登记表中"允许保留"的片段（授权外内容不进入提示词）；
 * - 模型输出的引用编号逐条回查登记表，伪造/无引用许可的编号被剔除并记因；
 * - 引用 DTO（版本、定位、哈希）只由登记表生成，模型输出不参与事实字段。
 */
import type { ResourceCitationDTO } from "@surreal-ck/shared";
import type { PlatformEvidence } from "./corpus-retrieval";

/** 私有资料证据（工作区 resource_item 的已保存证据片段）。 */
export type PrivateEvidence = Readonly<{
  resourceId: string;
  title: string;
  resourceType: string;
  sourceUrl: string | null;
  quote: string;
  /** evidence 数组内的序号（定位用）。 */
  order: number;
}>;

export type RegisteredEvidence = Readonly<{
  handle: number;
  sourceType: "platform" | "private";
  title: string;
  quote: string;
  /**
   * 该片段是否允许作为引用输出（平台项 = cite 许可；私有材料恒 true）。
   * false 时片段仍可进入模型上下文做分析，但引用它会被剔除。
   */
  quoteAllowed: boolean;
  /** 私有材料无平台版本概念；只在 platform 侧有值。 */
  platform: (Pick<PlatformEvidence, "versionId" | "itemId" | "versionPublicId" | "sourceKey" | "sourceUrl" | "locator" | "quoteSha256" | "bodySha256" | "kind"> & { versionLabel: string | null; entitlementRevision?: string }) | null;
  private: (Pick<PrivateEvidence, "resourceId" | "resourceType" | "sourceUrl" | "order">) | null;
}>;

export type CorpusAvailability = "ready" | "empty" | "unavailable";

export type ResearchEvidenceRegistry = {
  readonly entries: readonly RegisteredEvidence[];
  register(input: {
    sourceType: "platform" | "private";
    title: string;
    quote: string;
    quoteAllowed?: boolean;
    platform?: RegisteredEvidence["platform"];
    private?: RegisteredEvidence["private"];
  }): number | null;
  get(handle: number): RegisteredEvidence | undefined;
  readonly size: number;
};

/** 去重 + 上限的登记表：同来源同片段不重复登记（双语料合并去重）。 */
export function createEvidenceRegistry(limit: number): ResearchEvidenceRegistry {
  const entries: RegisteredEvidence[] = [];
  const seenQuotes = new Set<string>();
  return {
    get entries() {
      return entries;
    },
    get size() {
      return entries.length;
    },
    get(handle) {
      return entries[handle - 1];
    },
    register(input) {
      if (entries.length >= limit) return null;
      const quote = input.quote.trim();
      if (!quote) return null;
      const sourceId = input.platform?.versionId ?? input.private?.resourceId ?? input.title;
      const dedupeKey = `${input.sourceType}:${sourceId}:${quote}`;
      if (seenQuotes.has(dedupeKey)) return null;
      seenQuotes.add(dedupeKey);
      const handle = entries.length + 1;
      entries.push({
        handle,
        sourceType: input.sourceType,
        title: input.title,
        quote,
        quoteAllowed: input.quoteAllowed ?? true,
        platform: input.platform ?? null,
        private: input.private ?? null,
      });
      return handle;
    },
  };
}

// ─── 提示词构建（替身可检查：模型输入 = 纯登记证据） ──────────────────────────

export type ResearchPromptInput = {
  question: string;
  registry: ResearchEvidenceRegistry;
  corpusAvailability: CorpusAvailability;
};

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const platform = input.registry.entries.filter((entry) => entry.sourceType === "platform");
  const priv = input.registry.entries.filter((entry) => entry.sourceType === "private");
  const corpusLine = input.corpusAvailability === "ready"
    ? "平台授权语料已可用。"
    : input.corpusAvailability === "empty"
      ? "平台语料当前没有可授权集合（unavailable）。"
      : "平台语料当前不可用（unavailable）。";

  const quotable = platform.filter((entry) => entry.quoteAllowed);
  const referenceOnly = platform.filter((entry) => !entry.quoteAllowed);

  const lines: string[] = [
    "你是法律研究助手。回答必须满足：",
    "1. 只使用下方【平台法律语料】与【工作区私有材料】中列出的片段，引用时只写对应句柄编号，如 [1]、[2]。",
    "2. 禁止编造句柄编号、版本号或任何未列出的条文文本；没有证据支撑的结论必须明确写“证据不足”。",
    "3. 标注“仅参考、不可引用”的片段只能用于理解背景，禁止在回答中引用。",
    "4. 不要输出平台全文、令牌、密钥或授权状态细节。",
    `5. 当前平台语料状态：${corpusLine}${priv.length === 0 ? "工作区无相关私有材料。" : ""}`,
    "",
    "【平台法律语料】",
    ...(quotable.length === 0 ? ["（无可引用片段）"] : quotable.map((entry) => formatPlatformEntry(entry))),
    ...(referenceOnly.length === 0
      ? []
      : ["以下片段仅参考、不可引用：", ...referenceOnly.map((entry) => `[${entry.handle}] ${entry.title}：${entry.quote}`)]),
    "",
    "【工作区私有材料】",
    ...(priv.length === 0 ? ["（无）"] : priv.map((entry) => `[${entry.handle}] ${entry.title}：${entry.quote}`)),
    "",
    `【问题】${input.question}`,
    "",
    "请用简体中文回答：先给结论，再逐点说明依据（每点标注句柄编号），最后列出证据缺口。回答中引用只允许出现已列出的句柄编号。",
  ];
  return lines.join("\n");
}

function formatPlatformEntry(entry: RegisteredEvidence): string {
  const versionPart = entry.platform?.versionLabel ? `（版本 ${entry.platform.versionLabel}）` : "";
  return `[${entry.handle}] ${entry.title}${versionPart}：${entry.quote}`;
}

// ─── 后处理校验：伪造 / 无引用许可 / 未登记句柄全部剔除 ────────────────────────

export type RejectedCitation = Readonly<{
  handle: number;
  reason: "forged" | "cite_not_allowed" | "unsupported_quote";
}>;

export type ValidatedResearchAnswer = Readonly<{
  /** 仅保留通过校验的引用编号（按首次引用顺序）。 */
  citedHandles: number[];
  rejected: RejectedCitation[];
  citations: ResourceCitationDTO[];
}>;

/** 从模型文本解析 [n] 句柄（全文出现过的编号按序去重）。 */
export function parseCitationHandles(text: string): number[] {
  const handles: number[] = [];
  for (const match of text.matchAll(/\[(\d+)\]/gu)) {
    const handle = Number(match[1]);
    if (Number.isInteger(handle) && handle > 0 && !handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

/**
 * 逐条回查登记表：
 * - 编号不在登记表 → forged（模型编造）；
 * - 登记项 quoteAllowed=false（无 cite 许可的参考片段）→ cite_not_allowed；
 * - 通过校验的编号生成引用快照 DTO（事实字段全部来自登记表）。
 */
export function validateResearchAnswer(input: {
  modelText: string;
  registry: ResearchEvidenceRegistry;
}): ValidatedResearchAnswer {
  const handles = parseCitationHandles(input.modelText);
  const citedHandles: number[] = [];
  const rejected: RejectedCitation[] = [];
  for (const entry of input.registry.entries) {
    if (!entry.quoteAllowed && input.modelText.includes(entry.quote) && !handles.includes(entry.handle)) {
      rejected.push({ handle: entry.handle, reason: "cite_not_allowed" });
    }
  }
  for (const handle of handles) {
    const entry = input.registry.get(handle);
    if (!entry) {
      rejected.push({ handle, reason: "forged" });
      continue;
    }
    if (!entry.quoteAllowed) {
      rejected.push({ handle, reason: "cite_not_allowed" });
      continue;
    }
    // 直接引文必须是登记片段的原文子串；不能用真实句柄包装编造的条文。
    const clauses = input.modelText.split(/[。！？\n]/u).filter((clause) => clause.includes(`[${handle}]`));
    const quotes = clauses.flatMap((clause) => Array.from(clause.matchAll(/[“「"]([^”」"\n]+)[”」"]/gu), (match) => match[1]!));
    if (quotes.some((quote) => !entry.quote.includes(quote))) {
      rejected.push({ handle, reason: "unsupported_quote" });
      continue;
    }
    citedHandles.push(handle);
  }

  const citations = citedHandles.map((handle) => citationDTO(input.registry, handle, handle));
  return { citedHandles, rejected, citations };
}

/** 引用快照：只含允许保留的最小字段；不含 token、全文、向量或授权外候选。 */
export function citationDTO(registry: ResearchEvidenceRegistry, handle: number, index: number): ResourceCitationDTO {
  const entry = registry.get(handle);
  if (!entry) throw new Error(`citation handle ${handle} is not registered`);
  const base: ResourceCitationDTO = {
    index,
    resourceId: entry.sourceType === "platform" ? entry.platform!.itemId : entry.private!.resourceId,
    title: entry.title,
    evidence: [{ order: entry.private?.order ?? 0, text: entry.quote }],
  };
  if (entry.sourceType === "platform" && entry.platform) {
    return {
      ...base,
      sourceUrl: entry.platform.sourceUrl ?? undefined,
      platformContent: {
        itemId: entry.platform.itemId,
        versionId: entry.platform.versionId,
        sourceKey: entry.platform.sourceKey ?? "",
        versionPublicId: entry.platform.versionPublicId,
        quoteSha256: entry.platform.quoteSha256,
        entitlementRevision: entry.platform.entitlementRevision,
        locator: entry.platform.locator
          ? { start: entry.platform.locator.start, end: entry.platform.locator.end, bodyDigest: entry.platform.locator.bodyDigest }
          : null,
      },
    };
  }
  return {
    ...base,
    sourceUrl: entry.private?.sourceUrl ?? undefined,
  };
}

// ─── 回答文本组装：页面区分来源事实 / 用户材料 / 模型分析 / 覆盖说明 ────────────

export type ResearchAnswerAssemblyInput = {
  question: string;
  registry: ResearchEvidenceRegistry;
  corpusAvailability: CorpusAvailability;
  /** 平台不可用/为空时的稳定原因码（不泄漏原始错误链）。 */
  corpusNotice?: string;
  /** 因授权不足被拒的平台候选数（授权外候选不进入模型上下文，只记数量）。 */
  candidateRejections?: number;
  /** 模型分析文本（已校验）。 */
  analysisText: string;
  rejected: readonly RejectedCitation[];
  citedHandles: readonly number[];
};

export function assembleResearchAnswerText(input: ResearchAnswerAssemblyInput): string {
  const entries = input.registry.entries;
  const quotablePlatform = entries.filter((entry) => entry.sourceType === "platform" && entry.quoteAllowed);
  const referenceOnly = entries.filter((entry) => entry.sourceType === "platform" && !entry.quoteAllowed);
  const priv = entries.filter((entry) => entry.sourceType === "private");

  const sections: string[] = [];
  sections.push("【来源事实】（平台法律语料，精确版本）");
  sections.push(...(quotablePlatform.length === 0
    ? ["（无）"]
    : quotablePlatform.map((entry) => `[${entry.handle}] ${entry.title}${entry.platform?.versionLabel ? `（版本 ${entry.platform.versionLabel}）` : ""}：${entry.quote}`)));

  sections.push("");
  sections.push("【用户材料】（工作区私有资料）");
  sections.push(...(priv.length === 0 ? ["（无）"] : priv.map((entry) => `[${entry.handle}] ${entry.title}：${entry.quote}`)));

  sections.push("");
  sections.push("【模型分析】");
  // 不仅剔除引用 DTO：含不合法引用的整段模型分析也不进入消息/流/快照。
  sections.push(input.rejected.length > 0
    ? "模型引用未通过核验，已舍弃该分析；请依据上方证据或补充材料。"
    : input.analysisText.trim() || "证据不足，无法给出有依据的分析。");

  const gaps: string[] = [];
  if (input.corpusAvailability !== "ready") {
    gaps.push(input.corpusNotice
      ?? (input.corpusAvailability === "empty"
        ? "平台语料当前没有可授权集合，本回答仅基于工作区私有资料（partial）。"
        : "平台语料暂不可用，本回答仅基于工作区私有资料（partial）。"));
  }
  if (entries.length === 0) {
    gaps.push("未登记到任何可用证据；本回答不构成有来源的法律结论，请补充材料或稍后重试。");
  }
  if (referenceOnly.length > 0) {
    gaps.push(`有 ${referenceOnly.length} 条平台片段仅可参考、缺少引用许可，未作为来源事实列出。`);
  }
  if ((input.candidateRejections ?? 0) > 0) {
    gaps.push(`有 ${input.candidateRejections} 条平台候选因授权不足未纳入（未进入模型上下文）。`);
  }
  for (const item of input.rejected) {
    gaps.push(item.reason === "forged"
      ? `引用 [${item.handle}] 未通过核验（句柄未登记），已从引用中移除。`
      : item.reason === "cite_not_allowed"
        ? `引用 [${item.handle}] 缺少引用许可，已从引用中移除。`
        : `引用 [${item.handle}] 的直接引文不受证据支持，已舍弃该分析。`);
  }
  if (gaps.length > 0) {
    sections.push("");
    sections.push("【覆盖说明】");
    sections.push(...gaps.map((gap) => `- ${gap}`));
  }
  return sections.join("\n");
}
