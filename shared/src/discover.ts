import { z } from "zod";

/**
 * LCA11 公开发现与覆盖缺口提示：前后端共享契约。
 *
 * 安全边界：所有出参只含投影里被许可标记为可公开的安全元数据
 * （标题 / 类别 / 法域 / 日期 / 集合标签 / 聚合），绝不携带正文、
 * 实质摘要、裁判结论或向量。事件只记录结构化范围与转化状态，
 * 不记录法律问题原文、案件事实或私有摘录。
 */

const boundedLabel = z.string().trim().min(1).max(128);
const scopeKey = z.string().trim().min(1).max(64).regex(/^[a-z0-9_:-]+$/u);

/** 访客输入的研究问题：只用于本次解释，不落库。 */
export const discoverQuerySchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
});
export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;

export const DISCOVER_COVERAGE_STATUSES = ["full", "partial", "locked", "unavailable"] as const;
export type DiscoverCoverage = (typeof DISCOVER_COVERAGE_STATUSES)[number];

/** 投影条目对外可见的有限元数据。 */
export type DiscoverMatchedItem = {
  publicId: string;
  kind: "legislation" | "judicial_document";
  title: string;
  jurisdiction: string | null;
  publishedOn: string | null;
  sourceLabel: string;
  collectionKeys: string[];
};

/** 策划示例：运营显式写入投影的固定示例，不从正文生成。 */
export type DiscoverExample = {
  key: string;
  title: string;
  summary: string;
  citationLabels: string[];
};

export type DiscoverAggregates = {
  totalItems: number;
  kinds: { key: string; count: number }[];
  jurisdictions: { key: string; count: number }[];
  collections: { key: string; count: number }[];
  latestPublishedOn: string | null;
};

export type DiscoverOverview = {
  aggregates: DiscoverAggregates;
  examples: DiscoverExample[];
};

export type DiscoverSuggestion = {
  kind: "plan";
  planKey: string;
  planName: string;
  /** 该套餐能补齐的缺口集合 key。 */
  coversCollections: string[];
  /** 购买入口是否已在线开放；未上线时诚实标注，前端不得渲染成可点击购买。 */
  purchaseAvailable: boolean;
};

export type DiscoverScope = {
  kinds: string[];
  jurisdictions: string[];
  collectionKeys: string[];
  matchedCount: number;
  totalListed: number;
};

export type DiscoverQueryResult = {
  scope: DiscoverScope;
  matchedItems: DiscoverMatchedItem[];
  examples: DiscoverExample[];
};

export const discoverEntryKinds = ["upgrade", "request_admin", "none"] as const;
export type DiscoverEntryKind = (typeof discoverEntryKinds)[number];

export type DiscoverEvaluation = DiscoverQueryResult & {
  coverage: DiscoverCoverage;
  /** 已覆盖与缺口集合（用集合 key 表达，不含内容本体）。 */
  coveredCollections: string[];
  gapCollections: string[];
  suggestion: DiscoverSuggestion | null;
  /** 计费管理员得到升级入口；其他成员得到向管理员请求入口。 */
  entry: { kind: DiscoverEntryKind; planKey: string | null };
  /** 当前套餐仍能覆盖的部分说明。 */
  retainedNote: string;
};

/** 产品事件：只允许结构化范围 / 套餐 / 模块标识与转化状态，禁止自由文本。 */
export const discoverEventSchema = z.strictObject({
  kind: z.enum([
    "overview_view",
    "question",
    "evaluate",
    "suggestion_shown",
    "suggestion_dismissed",
    "entry_click",
    "entry_request",
  ]),
  scopeKinds: z.array(scopeKey).max(16).default([]),
  scopeCollections: z.array(scopeKey).max(16).default([]),
  planKey: z.string().trim().min(1).max(64).nullable().default(null),
  moduleKey: z.string().trim().min(1).max(64).nullable().default(null),
  conversion: z.enum(["none", "viewed", "clicked", "requested", "dismissed"]).default("none"),
});
export type DiscoverEventInput = z.infer<typeof discoverEventSchema>;

/** 运营重建投影的输入：策划示例由运营显式提供，不从内容正文派生。 */
export const discoverRebuildSchema = z.strictObject({
  examples: z.array(z.strictObject({
    key: boundedLabel.regex(/^[a-z][a-z0-9_-]{1,63}$/u),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2000),
    citationLabels: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
    position: z.number().int().min(0).max(999).default(0),
  })).max(64).default([]),
  reason: z.string().trim().min(1).max(500),
});
export type DiscoverRebuildRequest = z.infer<typeof discoverRebuildSchema>;
