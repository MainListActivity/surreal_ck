import { StringRecordId } from "surrealdb";
import { toSurrealNone } from "../db/surreal-values";
import type {
  DiscoverAggregates,
  DiscoverEvaluation,
  DiscoverEventInput,
  DiscoverMatchedItem,
  DiscoverOverview,
  DiscoverQueryResult,
  DiscoverRebuildRequest,
  DiscoverScope,
  DiscoverSuggestion,
} from "@surreal-ck/shared";

/**
 * LCA11 公开发现与安全覆盖缺口：领域服务。
 *
 * - content（content_publisher 会话）：读内容事实（item/version/source/license/
 *   binding/facet）、重建 content_discover_* 投影、写 discover_event。
 * - system（_system root 会话）：成员索引、权益快照指针、套餐目录、计费角色。
 *   root 只做控制面读取，不替客户读内容库正文——投影只含许可放行的安全元数据。
 * - 问题原文永不落库、永不进投影；事件只有结构化 scope/plan/module 标识。
 */

export type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] =>
  Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as Row[]) : [];

const str = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export class DiscoverError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "not-member"
      | "workspace-inactive"
      | "entitlement-absent"
      | "projection-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "DiscoverError";
  }
}

type DiscoverItemRow = {
  public_id: string;
  kind: string;
  title: string;
  jurisdiction: string | null;
  published_on: string | null;
  source_label: string;
  collections: string[];
};

type EntitlementLike = {
  collections: readonly { key: string; label: string }[];
} | null;

export type DiscoverServiceDeps = {
  /** 内容库 publisher 会话。 */
  content: Queryable;
  /** _system root 会话（控制面只读）。 */
  system: Queryable;
  /** 权益快照读取（成员覆盖评估用）。 */
  entitlementStore: {
    currentSnapshot(workspaceId: string): Promise<EntitlementLike>;
  };
  now?: () => Date;
};

const DISCOVER_ITEM_SELECT = `SELECT public_id, kind, title, jurisdiction, published_on,
  source_label, collections FROM content_discover_item WHERE listed = true;`;

function toMatchedItem(row: Row): DiscoverMatchedItem {
  return {
    publicId: str(row.public_id) ?? "",
    kind: row.kind === "judicial_document" ? "judicial_document" : "legislation",
    title: str(row.title) ?? "",
    jurisdiction: str(row.jurisdiction),
    publishedOn: str(row.published_on),
    sourceLabel: str(row.source_label) ?? "",
    collectionKeys: Array.isArray(row.collections) ? row.collections.map(String) : [],
  };
}

/**
 * 问题分词：拉丁词 + CJK 连续段。长 CJK 段几乎不可能整段命中标题，
 * 额外切 2-gram 作为召回项；短段保留原样。不引入分词器，只做保守子串匹配。
 */
export function questionTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const match of question.toLowerCase().matchAll(/[a-z0-9]{2,}|[一-鿿]{2,}/gu)) {
    const run = match[0];
    if (/^[一-鿿]+$/u.test(run) && run.length > 4) {
      for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
    } else {
      terms.add(run);
    }
    if (terms.size >= 64) break;
  }
  return [...terms].slice(0, 64);
}

function scoreItem(item: DiscoverItemRow, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystacks = [
    { text: item.title.toLowerCase(), weight: 3 },
    { text: (item.jurisdiction ?? "").toLowerCase(), weight: 2 },
    { text: item.source_label.toLowerCase(), weight: 1 },
    { text: item.collections.join(" ").toLowerCase(), weight: 1 },
  ];
  let score = 0;
  for (const term of terms) {
    for (const { text, weight } of haystacks) {
      if (text && text.includes(term)) {
        score += weight;
        break;
      }
    }
  }
  return score;
}

function scopeOf(matched: DiscoverMatchedItem[], totalListed: number): DiscoverScope {
  return {
    kinds: [...new Set(matched.map((item) => item.kind))],
    jurisdictions: [...new Set(matched.flatMap((item) => item.jurisdiction ? [item.jurisdiction] : []))],
    collectionKeys: [...new Set(matched.flatMap((item) => item.collectionKeys))],
    matchedCount: matched.length,
    totalListed,
  };
}

const MATCH_LIMIT = 5;

export function createDiscoverService(deps: DiscoverServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function listedRaw(): Promise<Row[]> {
    return rows(await deps.content.query(DISCOVER_ITEM_SELECT));
  }

  async function examples(): Promise<{ key: string; title: string; summary: string; citationLabels: string[] }[]> {
    const exampleRows = rows(await deps.content.query(
      `SELECT id, example_key, title, summary, citation_labels, position FROM content_discover_example
       WHERE status = "active" ORDER BY position ASC LIMIT 32;`,
    ));
    return exampleRows.map((row) => ({
      key: str(row.example_key) ?? "",
      title: str(row.title) ?? "",
      summary: str(row.summary) ?? "",
      citationLabels: Array.isArray(row.citation_labels) ? row.citation_labels.map(String) : [],
    }));
  }

  function matchQuestion(raw: Row[], question: string): DiscoverMatchedItem[] {
    const terms = questionTerms(question);
    return raw
      .map((row) => ({ row, score: scoreItem(row as unknown as DiscoverItemRow, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(a.row.public_id).localeCompare(String(b.row.public_id)))
      .slice(0, MATCH_LIMIT)
      .map((entry) => toMatchedItem(entry.row));
  }

  /** 事件只落结构化字段；调用方不传入任何自由文本。 */
  async function recordEvent(
    subjectKind: "visitor" | "member",
    event: DiscoverEventInput,
    workspaceDb?: string | null,
  ): Promise<void> {
    await deps.content.query(
      `INSERT INTO discover_event {
        kind: $kind, subject_kind: $subjectKind,
        scope_kinds: $scopeKinds, scope_collections: $scopeCollections,
        plan_key: $planKey, module_key: $moduleKey,
        conversion: $conversion, workspace: $workspace
      };`,
      {
        kind: event.kind,
        subjectKind,
        scopeKinds: event.scopeKinds,
        scopeCollections: event.scopeCollections,
        // JS null → NULL 会违反 option 字段类型；undefined → NONE。
        planKey: toSurrealNone(event.planKey),
        moduleKey: toSurrealNone(event.moduleKey),
        conversion: event.conversion,
        workspace: toSurrealNone(workspaceDb),
      },
    ).catch((cause) => {
      console.warn("[discover] event write failed", {
        kind: event.kind,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  return {
    /**
     * 重建公开发现投影：只放行"已发布 + 来源 active + 当前许可含 discover"的条目，
     * 许可未知/到期或内容撤回的条目标记 listed=false（表禁删，投影可重放）。
     */
    async rebuildProjection(
      operatorSubject: string,
      request: DiscoverRebuildRequest,
    ): Promise<{ listed: number; delisted: number; examples: number }> {
      const facetRows = rows(await deps.content.query(
        `SELECT item, version, kind, jurisdiction, published_on,
                item.public_id AS public_id,
                version.title AS title, version.source AS source
         FROM content_search_facet
         WHERE item.publication_status = "published" AND item.current_version = version;`,
      ));
      const sourceRows = rows(await deps.content.query(
        "SELECT id, source_key, label, status FROM content_source;",
      ));
      const licenseRows = rows(await deps.content.query(
        "SELECT id, source, revision, allowed_actions, effective_from, effective_until FROM source_license_revision;",
      ));
      const bindingRows = rows(await deps.content.query(
        "SELECT item, collections FROM content_collection_binding;",
      ));
      const collectionsByItem = new Map<string, string[]>();
      for (const binding of bindingRows) {
        collectionsByItem.set(String(binding.item), Array.isArray(binding.collections) ? binding.collections.map(String) : []);
      }
      const sourcesById = new Map(sourceRows.map((row) => [String(row.id), row]));
      const licensesBySource = new Map<string, Row[]>();
      for (const license of licenseRows) {
        const key = String(license.source);
        licensesBySource.set(key, [...(licensesBySource.get(key) ?? []), license]);
      }

      const nowDate = now();
      const eligible = new Map<string, { row: Row; licenseId: unknown }>();
      for (const facet of facetRows) {
        const source = sourcesById.get(String(facet.source));
        if (!source || source.status !== "active") continue;
        const license = (licensesBySource.get(String(facet.source)) ?? [])
          .filter((entry) => {
            const from = new Date(String(entry.effective_from));
            const until = entry.effective_until ? new Date(String(entry.effective_until)) : null;
            return from <= nowDate && (until === null || until > nowDate);
          })
          .sort((a, b) => num(b.revision) - num(a.revision))[0];
        if (!license) continue;
        const actions = Array.isArray(license.allowed_actions) ? license.allowed_actions.map(String) : [];
        if (!actions.includes("discover")) continue;
        eligible.set(String(facet.item), { row: facet, licenseId: license.id });
      }

      for (const [itemId, { row, licenseId }] of eligible) {
        await deps.content.query(
          `INSERT INTO content_discover_item {
            item: $item, version: $version, public_id: $publicId, kind: $kind,
            title: $title, jurisdiction: $jurisdiction, published_on: $publishedOn,
            source_key: $sourceKey, source_label: $sourceLabel, collections: $collections,
            listed: true, license_revision: $license, listed_at: time::now(), delisted_at: NONE
          } ON DUPLICATE KEY UPDATE
            version = $version, public_id = $publicId, kind = $kind, title = $title,
            jurisdiction = $jurisdiction, published_on = $publishedOn,
            source_key = $sourceKey, source_label = $sourceLabel, collections = $collections,
            listed = true, license_revision = $license, listed_at = time::now(), delisted_at = NONE,
            rebuilt_at = time::now();`,
          {
            item: new StringRecordId(itemId),
            version: new StringRecordId(String(row.version)),
            publicId: str(row.public_id) ?? "",
            kind: str(row.kind) ?? "legislation",
            title: str(row.title) ?? "",
            jurisdiction: toSurrealNone(str(row.jurisdiction)),
            publishedOn: toSurrealNone(str(row.published_on)),
            sourceKey: str(sourcesById.get(String(row.source))?.source_key) ?? "",
            sourceLabel: str(sourcesById.get(String(row.source))?.label) ?? "",
            collections: collectionsByItem.get(itemId) ?? [],
            license: licenseId instanceof StringRecordId ? licenseId : new StringRecordId(String(licenseId)),
          },
        );
      }

      let delisted = 0;
      const existingRows = rows(await deps.content.query(
        "SELECT id, item, listed FROM content_discover_item WHERE listed = true;",
      ));
      for (const existing of existingRows) {
        if (eligible.has(String(existing.item))) continue;
        await deps.content.query(
          "UPDATE $id SET listed = false, delisted_at = time::now(), rebuilt_at = time::now();",
          { id: new StringRecordId(String(existing.id)) },
        );
        delisted += 1;
      }

      for (const example of request.examples) {
        await deps.content.query(
          `INSERT INTO content_discover_example {
            example_key: $key, title: $title, summary: $summary,
            citation_labels: $citations, position: $position, status: "active",
            created_by_subject: $actor
          } ON DUPLICATE KEY UPDATE
            title = $title, summary = $summary, citation_labels = $citations,
            position = $position, status = "active", updated_at = time::now();`,
          {
            key: example.key,
            title: example.title,
            summary: example.summary,
            citations: example.citationLabels,
            position: example.position,
            actor: operatorSubject,
          },
        );
      }
      return { listed: eligible.size, delisted, examples: request.examples.length };
    },

    /** 访客总览：安全聚合 + 策划示例，不出条目明细。 */
    async overview(): Promise<DiscoverOverview> {
      const items = await listedRaw();
      const kinds = new Map<string, number>();
      const jurisdictions = new Map<string, number>();
      const collections = new Map<string, number>();
      let latestPublishedOn: string | null = null;
      for (const row of items) {
        const kind = str(row.kind) ?? "legislation";
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        const jurisdiction = str(row.jurisdiction);
        if (jurisdiction) jurisdictions.set(jurisdiction, (jurisdictions.get(jurisdiction) ?? 0) + 1);
        for (const key of Array.isArray(row.collections) ? row.collections : []) {
          const collection = String(key);
          collections.set(collection, (collections.get(collection) ?? 0) + 1);
        }
        const publishedOn = str(row.published_on);
        if (publishedOn && (!latestPublishedOn || publishedOn > latestPublishedOn)) {
          latestPublishedOn = publishedOn;
        }
      }
      const aggregates: DiscoverAggregates = {
        totalItems: items.length,
        kinds: [...kinds.entries()].map(([key, count]) => ({ key, count })),
        jurisdictions: [...jurisdictions.entries()].map(([key, count]) => ({ key, count })),
        collections: [...collections.entries()].map(([key, count]) => ({ key, count })),
        latestPublishedOn,
      };
      const exampleList = await examples();
      void recordEvent("visitor", {
        kind: "overview_view", scopeKinds: [], scopeCollections: [],
        planKey: null, moduleKey: null, conversion: "viewed",
      });
      return { aggregates, examples: exampleList };
    },

    /** 访客提问：确定性范围解释 + 有限元数据，绝不输出正文/摘要/结论。 */
    async publicQuery(question: string): Promise<DiscoverQueryResult> {
      const raw = await listedRaw();
      const matched = matchQuestion(raw, question);
      const scope = scopeOf(matched, raw.length);
      const exampleList = await examples();
      void recordEvent("visitor", {
        kind: "question",
        scopeKinds: scope.kinds,
        scopeCollections: scope.collectionKeys,
        planKey: null, moduleKey: null, conversion: "none",
      });
      return { scope, matchedItems: matched, examples: exampleList };
    },

    /**
     * 成员覆盖评估：同一匹配集合对调用者当前权益求交。
     * full=已覆盖全部命中集合；partial=覆盖一部分；locked=平台有覆盖但成员没有；
     * unavailable=平台也没有可证明覆盖（只说明证据不足，不编造）。
     */
    async evaluateMember(input: {
      question: string;
      subject: string;
      workspaceDb: string;
    }): Promise<DiscoverEvaluation> {
      const [workspaceRows, memberRows] = await Promise.all([
        deps.system.query(
          'SELECT id, db_name, status FROM workspace WHERE db_name = $db LIMIT 1;',
          { db: input.workspaceDb },
        ).then(rows),
        deps.system.query(
          'SELECT subject, disabled_at FROM user_workspace_index WHERE db_name = $db AND subject = $subject LIMIT 1;',
          { db: input.workspaceDb, subject: input.subject },
        ).then(rows),
      ]);
      const workspace = workspaceRows[0];
      if (!workspace?.id) throw new DiscoverError("workspace-inactive", "workspace not found");
      if (workspace.status !== "active") throw new DiscoverError("workspace-inactive", "workspace not active");
      if (!memberRows[0] || memberRows[0].disabled_at != null) {
        throw new DiscoverError("not-member", "caller is not an active member");
      }

      const snapshot = await deps.entitlementStore.currentSnapshot(String(workspace.id));
      const memberCollections = new Set((snapshot?.collections ?? []).map((item) => item.key));

      const raw = await listedRaw();
      const matched = matchQuestion(raw, input.question);
      const scope = scopeOf(matched, raw.length);
      const matchedCollections = scope.collectionKeys;
      const covered = matchedCollections.filter((key) => memberCollections.has(key));
      const gap = matchedCollections.filter((key) => !memberCollections.has(key));

      const coverage =
        matched.length === 0 ? "unavailable"
        : gap.length === 0 ? "full"
        : covered.length === 0 ? "locked"
        : "partial";

      // 套餐目录：_system 控制面读取，挑一个能补齐缺口的单一首选。
      const suggestion = coverage === "partial" || coverage === "locked"
        ? await findPlanSuggestion(deps.system, gap)
        : null;

      const billingRole = await billingRoleFor(deps.system, String(workspace.id), input.subject);
      const entry = suggestion === null
        ? { kind: "none" as const, planKey: null }
        : billingRole === "owner" || billingRole === "admin"
          ? { kind: "upgrade" as const, planKey: suggestion.planKey }
          : { kind: "request_admin" as const, planKey: suggestion.planKey };

      const retainedNote = covered.length > 0
        ? `当前套餐仍可研究已覆盖的内容集合（${covered.join("、")}）。`
        : snapshot
          ? "当前套餐未覆盖本次命中范围；既有浏览与研究工作不受影响。"
          : "当前工作区暂无内容权益；可先使用现有功能。";

      void recordEvent("member", {
        kind: "evaluate",
        scopeKinds: scope.kinds,
        scopeCollections: scope.collectionKeys,
        planKey: suggestion?.planKey ?? null,
        moduleKey: null,
        conversion: "none",
      }, input.workspaceDb);
      if (suggestion) {
        void recordEvent("member", {
          kind: "suggestion_shown",
          scopeKinds: scope.kinds,
          scopeCollections: gap,
          planKey: suggestion.planKey,
          moduleKey: null,
          conversion: "viewed",
        }, input.workspaceDb);
      }

      return {
        scope,
        matchedItems: matched,
        examples: await examples(),
        coverage,
        coveredCollections: covered,
        gapCollections: gap,
        suggestion,
        entry,
        retainedNote,
      };
    },

    recordEvent,
  };
}

/** 从 _system 套餐目录挑一个覆盖缺口集合的单一首选套餐。 */
async function findPlanSuggestion(
  system: Queryable,
  gapCollections: string[],
): Promise<DiscoverSuggestion | null> {
  if (gapCollections.length === 0) return null;
  const planRows = rows(await system.query(
    `SELECT plan.plan_key AS plan_key, plan.display_name AS plan_name,
            active_revision.content_template.collections AS collections
     FROM product_plan
     WHERE status = "active" AND active_revision != NONE;`,
  ));
  const gap = new Set(gapCollections);
  let best: { planKey: string; planName: string; covers: string[]; total: number } | null = null;
  for (const row of planRows) {
    const planKey = str(row.plan_key);
    if (!planKey) continue;
    const keys = (Array.isArray(row.collections) ? row.collections : [])
      .map((item) => str((item as Row)?.collection_key))
      .filter((key): key is string => key !== null);
    const covers = [...gap].filter((key) => keys.includes(key));
    if (covers.length !== gap.size) continue;
    const candidate = { planKey, planName: str(row.plan_name) ?? planKey, covers, total: keys.length };
    // 覆盖全部缺口的前提下选更聚焦（集合总数更少）的；再按 plan_key 定序保证确定。
    if (!best || candidate.total < best.total || (candidate.total === best.total && planKey < best.planKey)) {
      best = candidate;
    }
  }
  return best
    ? { kind: "plan", planKey: best.planKey, planName: best.planName, coversCollections: best.covers, purchaseAvailable: false }
    : null;
}

/** workspace → 当前生效订阅 → 计费账户 → 调用者角色。 */
async function billingRoleFor(
  system: Queryable,
  workspaceId: string,
  subject: string,
): Promise<"owner" | "admin" | "viewer" | null> {
  const accountRows = rows(await system.query(
    `SELECT VALUE subscription.billing_account FROM quota_subscription_item
     WHERE workspace = $workspace AND status = "active" LIMIT 1;`,
    { workspace: new StringRecordId(workspaceId) },
  ));
  const account = accountRows[0];
  if (account == null) return null;
  const roleRows = rows(await system.query(
    `SELECT VALUE role FROM billing_account_member
     WHERE billing_account = $account AND subject = $subject AND status = "active" LIMIT 1;`,
    { account: account instanceof StringRecordId ? account : new StringRecordId(String(account)), subject },
  ));
  const role = str(roleRows[0]);
  return role === "owner" || role === "admin" || role === "viewer" ? role : null;
}

export type DiscoverService = ReturnType<typeof createDiscoverService>;
